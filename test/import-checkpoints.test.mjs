import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import {
  createImportCheckpointManager, supportsImportCheckpointVersion, ImportCheckpointBacklogError, ImportCheckpointRestoreError,
} from '../lib/import-checkpoints.mjs'

const workerUrl = new URL('../lib/import-checkpoint-worker.mjs', import.meta.url)
const runtimeProbe = new DatabaseSync(':memory:')
const fixedRuntime = supportsImportCheckpointVersion(runtimeProbe.prepare('SELECT sqlite_version() AS version').get().version)
runtimeProbe.close()
// Old, supported Node installations intentionally retain automatic checkpoints. Do not exercise
// the historical concurrent-WAL corruption bug merely to test an optimization disabled there.
const fixedTest = (name, options, fn) => test(name, { ...options, skip: !fixedRuntime }, fn)
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const auto = db => db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint
const sync = db => db.prepare('PRAGMA synchronous').get().synchronous
const quiet = () => {}
function fixture() {
  // Include URI metacharacters and a space: mode=rw must not turn the filename into options.
  const dir = mkdtempSync(join(tmpdir(), 'psc-checkpoint-')), path = join(dir, 'shop #one % two.db')
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=37; CREATE TABLE items(id INTEGER PRIMARY KEY, payload BLOB)')
  return { db, path, dir, close() { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}
const realWorker = data => new Worker(workerUrl, { workerData: data })

test('checkpoint version guard rejects the WAL-reset-vulnerable supported Node floor', () => {
  for (const value of ['3.47.2', '3.51.2', '3.50.6', '3.44.5', '3.51', 'x', undefined, '999999999999999999999.1.2']) assert.equal(supportsImportCheckpointVersion(value), false, String(value))
  for (const value of ['3.51.3', '3.53.4', '3.100.0', '4.0.0']) assert.equal(supportsImportCheckpointVersion(value), true, value)
})

test('default launcher handles input-type and process flags while preserving worker preloads', { timeout: 30000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-checkpoint-launch-'))
  const helperUrl = new URL('../lib/import-checkpoints.mjs', import.meta.url).href
  try {
    for (const [index, inputType] of [['--input-type=module'], ['--input-type', 'module'], ['--input-type=commonjs']].entries()) {
      const log = join(dir, `preload-${index}.log`), preload = join(dir, `preload-${index}.mjs`), path = join(dir, `shop-${index}.db`)
      writeFileSync(preload, `import {threadId} from 'node:worker_threads'; import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(log)},String(threadId)+'\\n');`)
      const code = `(async()=>{
        const assert=(await import('node:assert/strict')).default;
        const {DatabaseSync}=await import('node:sqlite');
        const {createImportCheckpointManager,supportsImportCheckpointVersion}=await import(${JSON.stringify(helperUrl)});
        const db=new DatabaseSync(${JSON.stringify(path)});
        db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=37; CREATE TABLE sample(id INTEGER)');
        const supported=supportsImportCheckpointVersion(db.prepare('SELECT sqlite_version() v').get().v);
        const diagnostics=[],manager=createImportCheckpointManager({diagnostic:event=>diagnostics.push(event)});
        try{
          await manager.withImportCheckpoints(db,async checkpoint=>{
            assert.equal(db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint,supported?0:37);
            db.exec('INSERT INTO sample VALUES(1)');
            assert.equal(Boolean(await checkpoint()),supported);
            assert.equal(db.prepare('PRAGMA synchronous').get().synchronous,2);
          });
          assert.equal(db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint,37);
          assert.equal(db.prepare('SELECT COUNT(*) n FROM sample').get().n,1);
          assert.equal(manager.importCheckpointActive(db),false);
          if(supported)assert.ok(!diagnostics.some(event=>event.event==='fallback'),JSON.stringify(diagnostics));
          console.log(JSON.stringify({supported}));
        }finally{await manager.shutdownImportCheckpoints();db.close()}
      })().catch(error=>{console.error(error);process.exitCode=1})`
      // --stack-trace-limit is a normal parent-process option but forbidden as explicit worker
      // execArgv. Node's standard inheritance handles it without dropping the --import preload.
      const output = execFileSync(process.execPath, ['--no-warnings', '--stack-trace-limit=17', '--import', pathToFileURL(preload).href, ...inputType, '--eval', code], { encoding: 'utf8', timeout: 10000 })
      const result = JSON.parse(output.trim())
      assert.equal(result.supported, fixedRuntime)
      const threads = readFileSync(log, 'utf8').trim().split('\n').map(Number)
      assert.ok(threads.includes(0), 'parent preload ran')
      assert.equal(threads.some(id => id > 0), fixedRuntime, 'eligible worker inherits the preload too')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

fixedTest('real PASSIVE checkpoint coexists with a writer and preserves FULL and original auto configuration', { timeout: 20000 }, async () => {
  const f = fixture(), manager = createImportCheckpointManager({ diagnostic: quiet })
  let reader
  try {
    const result = await manager.withImportCheckpoints(f.db, async checkpoint => {
      assert.equal(manager.importCheckpointActive(f.db), true)
      assert.equal(auto(f.db), 0)
      assert.equal(sync(f.db), 2)
      f.db.exec('BEGIN IMMEDIATE; INSERT INTO items(payload) VALUES(zeroblob(1048576)); COMMIT')
      reader = new DatabaseSync(f.path, { readOnly: true })
      assert.equal(reader.prepare('SELECT COUNT(*) n FROM items').get().n, 1)
      f.db.exec('BEGIN IMMEDIATE; INSERT INTO items(payload) VALUES(zeroblob(4096))')
      // FULL/RESTART would need this writer's lock. PASSIVE can finish without asking it to end.
      const checked = await checkpoint()
      assert.ok(checked)
      assert.equal(checked.busy, 0)
      assert.ok(checked.log > 0)
      assert.equal(reader.prepare('SELECT COUNT(*) n FROM items').get().n, 1, 'other connections still see committed state')
      f.db.exec('COMMIT')
      await checkpoint()
      assert.equal(reader.prepare('SELECT COUNT(*) n FROM items').get().n, 2)
      return 'saved'
    })
    assert.equal(result, 'saved')
    assert.equal(auto(f.db), 37)
    assert.equal(sync(f.db), 2)
    assert.equal(manager.importCheckpointActive(f.db), false)
    assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { reader?.close(); await manager.shutdownImportCheckpoints(); f.close() }
})

fixedTest('nested and concurrent leases share one worker and restore only after the last caller', { timeout: 20000 }, async () => {
  const f = fixture(), workers = [], manager = createImportCheckpointManager({ diagnostic: quiet, createWorker: data => { const worker = realWorker(data); workers.push(worker); return worker } })
  const oneReady = deferred(), releaseOne = deferred(), twoReady = deferred(), releaseTwo = deferred()
  let first, second
  try {
    first = manager.withImportCheckpoints(f.db, async checkpoint => {
      await manager.withImportCheckpoints(f.db, async nested => { assert.equal(auto(f.db), 0); await nested() })
      assert.equal(auto(f.db), 0)
      oneReady.resolve()
      await releaseOne.promise
      await checkpoint()
    })
    await oneReady.promise
    second = manager.withImportCheckpoints(f.db, async checkpoint => {
      assert.equal(auto(f.db), 0)
      f.db.exec('INSERT INTO items(payload) VALUES(zeroblob(10000))')
      // Parallel requests are coalesced; all settle and include a pass after the latest request.
      const results = await Promise.all(Array.from({ length: 20 }, () => checkpoint()))
      assert.ok(results.every(result => result && result.busy === 0))
      twoReady.resolve()
      await releaseTwo.promise
    })
    await twoReady.promise
    releaseOne.resolve(); await first
    assert.equal(workers.length, 1)
    assert.equal(auto(f.db), 0)
    assert.equal(manager.importCheckpointActive(f.db), true)
    releaseTwo.resolve(); await second
    assert.equal(auto(f.db), 37)
    assert.equal(manager.importCheckpointActive(f.db), false)
  } finally { releaseOne.resolve(); releaseTwo.resolve(); await Promise.allSettled([first, second]); await manager.shutdownImportCheckpoints(); f.close() }
})

fixedTest('two-worker cap keeps a third shop on ordinary auto-checkpoints with its import guard active', { timeout: 20000 }, async () => {
  const fixtures = [fixture(), fixture(), fixture()], released = deferred(), started = [deferred(), deferred()]
  let spawned = 0
  const manager = createImportCheckpointManager({ diagnostic: quiet, createWorker: data => { spawned++; return realWorker(data) } })
  const tasks = fixtures.slice(0, 2).map((f, i) => manager.withImportCheckpoints(f.db, async () => { assert.equal(auto(f.db), 0); started[i].resolve(); await released.promise }))
  try {
    await Promise.all(started.map(x => x.promise))
    await manager.withImportCheckpoints(fixtures[2].db, async checkpoint => {
      assert.equal(auto(fixtures[2].db), 37)
      assert.equal(manager.importCheckpointActive(fixtures[2].db), true)
      assert.equal(await checkpoint(), null)
    })
    assert.equal(spawned, 2)
    assert.equal(manager.importCheckpointActive(fixtures[2].db), false)
  } finally { released.resolve(); await Promise.allSettled(tasks); await manager.shutdownImportCheckpoints(); fixtures.forEach(f => f.close()) }
})

fixedTest('callback failure, worker crash and worker startup failure preserve committed data and settings', { timeout: 20000 }, async () => {
  const f = fixture(), diagnostics = []
  let worker
  const manager = createImportCheckpointManager({ diagnostic: event => diagnostics.push(event), createWorker: data => { worker = realWorker(data); return worker } })
  try {
    const original = Error('import caller failed')
    await assert.rejects(manager.withImportCheckpoints(f.db, async checkpoint => {
      f.db.exec('INSERT INTO items(payload) VALUES(zeroblob(20000))')
      await checkpoint()
      throw original
    }), error => error === original)
    assert.equal(auto(f.db), 37)
    assert.equal(manager.importCheckpointActive(f.db), false)
    await manager.withImportCheckpoints(f.db, async checkpoint => {
      f.db.exec('INSERT INTO items(payload) VALUES(zeroblob(20000))')
      const pending = checkpoint()
      await worker.terminate()
      await pending
      assert.equal(auto(f.db), 37)
      assert.equal(await checkpoint(), null)
      assert.equal(manager.importCheckpointActive(f.db), true, 'a fallback import still owns its database lease')
      f.db.exec('INSERT INTO items(payload) VALUES(zeroblob(10))')
    })
    assert.equal(manager.importCheckpointActive(f.db), false)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM items').get().n, 3)
    assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.ok(diagnostics.some(event => event.reason === 'worker-exit'))
    const failed = createImportCheckpointManager({ diagnostic: quiet, createWorker: () => new Worker(new URL('./missing-checkpoint-worker.mjs', import.meta.url)) })
    try {
      await failed.withImportCheckpoints(f.db, async checkpoint => {
        assert.equal(auto(f.db), 37)
        assert.equal(await checkpoint(), null)
        f.db.exec('INSERT INTO items(payload) VALUES(zeroblob(10))')
      })
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM items').get().n, 4)
      assert.equal(failed.importCheckpointActive(f.db), false)
    } finally { await failed.shutdownImportCheckpoints() }
    assert.equal(sync(f.db), 2)
  } finally { await manager.shutdownImportCheckpoints(); f.close() }
})

test('worker mode=rw never creates a missing database or directory', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-checkpoint-missing-'))
  try {
    for (const path of [join(dir, 'missing.db'), join(dir, 'missing', 'shop.db')]) {
      const uri = pathToFileURL(path); uri.search = '?mode=rw'
      const worker = realWorker({ uri: uri.href }), messages = []
      worker.on('message', message => messages.push(message))
      const code = await new Promise((resolve, reject) => { worker.on('error', reject); worker.on('exit', resolve) })
      assert.equal(code, 0)
      assert.ok(messages.some(message => message.type === 'startup-error'))
      assert.equal(existsSync(path), false)
    }
    assert.equal(existsSync(join(dir, 'missing')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

fixedTest('checkpoint timeout falls back safely and never releases its guard or replaces an unobserved worker', { timeout: 20000 }, async () => {
  const f = fixture(), diagnostics = []
  const keepAlive = setInterval(() => {}, 1000) // the proxy intentionally withholds its real worker's terminal event
  let spawned = 0, observedExit, delayedWorker
  const actualExit = deferred()
  // A real worker opens the same DB and becomes ready, but fails to answer maintenance calls.
  // Delay delivery of its exit event to prove timeout alone never releases the capacity/guard.
  const manager = createImportCheckpointManager({
    diagnostic: event => diagnostics.push(event), checkpointTimeoutMs: 30, closeTimeoutMs: 30,
    createWorker: data => {
      spawned++
      const real = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(workerData.uri);
        parentPort.postMessage({ type: 'ready', version: db.prepare('SELECT sqlite_version() v').get().v, pageSize: 4096 });
        parentPort.on('message', () => {});
      `, { eval: true, workerData: data })
      const proxy = delayedWorker = new EventEmitter()
      proxy.postMessage = message => real.postMessage(message)
      proxy.terminate = () => real.terminate()
      real.on('message', message => proxy.emit('message', message))
      real.on('error', error => proxy.emit('error', error))
      real.on('exit', code => { observedExit = () => proxy.emit('exit', code); actualExit.resolve() })
      return proxy
    },
  })
  try {
    await manager.withImportCheckpoints(f.db, async checkpoint => {
      f.db.exec('INSERT INTO items(payload) VALUES(zeroblob(20000))')
      assert.equal(await checkpoint(), null)
      assert.equal(auto(f.db), 37)
    })
    await actualExit.promise
    assert.equal(manager.importCheckpointActive(f.db), true, 'exit must be observed before deletion becomes safe')
    await manager.withImportCheckpoints(f.db, async checkpoint => { assert.equal(await checkpoint(), null); assert.equal(auto(f.db), 37) })
    assert.equal(spawned, 1, 'an observation timeout does not permit a replacement worker')
    assert.ok(diagnostics.some(event => event.reason === 'checkpoint-timeout'))
    observedExit(); observedExit = null
    assert.equal(manager.importCheckpointActive(f.db), false)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM items').get().n, 1)
    assert.equal(sync(f.db), 2)
  } finally { observedExit?.(); delayedWorker?.removeAllListeners(); await manager.shutdownImportCheckpoints(); clearInterval(keepAlive); f.close() }
})

fixedTest('two transient restore failures retain the original threshold through close and worker exit', { timeout: 20000 }, async () => {
  const f = fixture(), diagnostics = []
  let failures = 2, restores = 0
  const db = {
    prepare: sql => f.db.prepare(sql),
    exec(sql) {
      if (sql === 'PRAGMA wal_autocheckpoint=37') {
        restores++
        if (failures-- > 0) throw Error('fixture transient checkpoint restore failure')
      }
      return f.db.exec(sql)
    },
  }
  const manager = createImportCheckpointManager({ diagnostic: event => diagnostics.push(event) })
  try {
    const result = await manager.withImportCheckpoints(db, async checkpoint => {
      assert.equal(auto(f.db), 0)
      f.db.exec('INSERT INTO items(payload) VALUES(zeroblob(20000))')
      await checkpoint()
      return 'import completed'
    })
    assert.equal(result, 'import completed', 'cleanup failures must not invent a failed/rolled-back import')
    assert.equal(restores, 3, 'close and exit failed; cleanup retained and restored the original value')
    assert.equal(diagnostics.filter(event => event.reason === 'restore-failed').length, 2)
    assert.equal(auto(f.db), 37)
    assert.equal(sync(f.db), 2)
    assert.equal(manager.importCheckpointActive(db), false, 'restored state with no worker is no longer an active import')
    await manager.shutdownImportCheckpoints()
    assert.equal(auto(f.db), 37)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM items').get().n, 1)
  } finally { failures = 0; await manager.shutdownImportCheckpoints(); f.close() }
})

fixedTest('persistent restore failure stops subsequent batches and recovers on a later lease or shutdown', { timeout: 20000 }, async () => {
  const f = fixture()
  let broken = true, spawned = 0
  const db = {
    prepare: sql => f.db.prepare(sql),
    exec(sql) {
      if (sql === 'PRAGMA wal_autocheckpoint=37' && broken) throw Error('fixture restore unavailable')
      return f.db.exec(sql)
    },
  }
  const manager = createImportCheckpointManager({ diagnostic: quiet, createWorker: data => { spawned++; return realWorker(data) } })
  try {
    assert.equal(await manager.withImportCheckpoints(db, async checkpoint => {
      f.db.exec('INSERT INTO items(payload) VALUES(NULL)'); await checkpoint(); return 1
    }), 1)
    assert.equal(auto(f.db), 0)
    assert.equal(manager.importCheckpointActive(db), true, 'the saved original setting remains recoverable')
    let committed = 0
    await assert.rejects(manager.withImportCheckpoints(db, async checkpoint => {
      for (let batch = 0; batch < 3; batch++) {
        f.db.exec('INSERT INTO items(payload) VALUES(NULL)'); committed++
        await checkpoint()
      }
    }), error => error instanceof ImportCheckpointRestoreError && error.code === 'import_checkpoint_restore_failed' && /completed batches are still saved/.test(error.message))
    assert.equal(committed, 1, 'the failed maintenance boundary stops further batches without undoing its saved one')
    assert.equal(spawned, 1, 'a retained zero threshold cannot be adopted by a replacement worker')
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM items').get().n, 2)
    broken = false
    await manager.withImportCheckpoints(db, async checkpoint => { assert.equal(auto(f.db), 0); await checkpoint() })
    assert.equal(spawned, 2, 'new worker starts only after the saved original threshold was recovered')
    assert.equal(auto(f.db), 37)
    assert.equal(manager.importCheckpointActive(db), false)
    broken = true
    await manager.withImportCheckpoints(db, async checkpoint => { await checkpoint() })
    assert.equal(auto(f.db), 0)
    broken = false
    await manager.shutdownImportCheckpoints()
    assert.equal(auto(f.db), 37, 'shutdown can still recover retained settings after the worker has already exited')
    assert.equal(manager.importCheckpointActive(db), false)
    assert.equal(sync(f.db), 2)
  } finally { broken = false; await manager.shutdownImportCheckpoints(); f.close() }
})

test('in-memory, operator-off and vulnerable-engine fallbacks never start a worker or change durability', async () => {
  const f = fixture(), memory = new DatabaseSync(':memory:')
  let attempts = 0
  const manager = createImportCheckpointManager({ diagnostic: quiet, createWorker: () => { attempts++; throw Error('unexpected worker') } })
  const prior = process.env.PSC_IMPORT_CHECKPOINTS
  try {
    await manager.withImportCheckpoints(memory, async checkpoint => { assert.equal(await checkpoint(), null); assert.equal(manager.importCheckpointActive(memory), true) })
    process.env.PSC_IMPORT_CHECKPOINTS = 'off'
    await manager.withImportCheckpoints(f.db, async checkpoint => { assert.equal(auto(f.db), 37); assert.equal(await checkpoint(), null) })
    delete process.env.PSC_IMPORT_CHECKPOINTS
    const oldDb = { prepare(sql) { return sql === 'SELECT sqlite_version() AS version' ? { get: () => ({ version: '3.47.2' }) } : f.db.prepare(sql) } }
    await manager.withImportCheckpoints(oldDb, async checkpoint => { assert.equal(await checkpoint(), null); assert.equal(auto(f.db), 37) })
    assert.equal(attempts, 0)
    assert.equal(sync(f.db), 2)
    assert.equal(manager.importCheckpointActive(oldDb), false)
  } finally { if (prior === undefined) delete process.env.PSC_IMPORT_CHECKPOINTS; else process.env.PSC_IMPORT_CHECKPOINTS = prior; await manager.shutdownImportCheckpoints(); memory.close(); f.close() }
})

fixedTest('pinned reader stops imports above 64 MiB of pending WAL without undoing saved batches', { timeout: 30000 }, async () => {
  const f = fixture(), manager = createImportCheckpointManager({ diagnostic: quiet })
  let reader, committed = 0
  try {
    f.db.exec('INSERT INTO items(payload) VALUES(NULL)')
    reader = new DatabaseSync(f.path, { readOnly: true })
    reader.exec('BEGIN'); reader.prepare('SELECT COUNT(*) FROM items').get()
    await assert.rejects(manager.withImportCheckpoints(f.db, async checkpoint => {
      const insert = f.db.prepare('INSERT INTO items(payload) VALUES(zeroblob(1048576))')
      for (let batch = 0; batch < 12; batch++) {
        f.db.exec('BEGIN IMMEDIATE')
        for (let row = 0; row < 8; row++) insert.run()
        f.db.exec('COMMIT'); committed += 8
        await checkpoint()
      }
    }), error => error instanceof ImportCheckpointBacklogError && error.code === 'import_checkpoint_backlog' && error.backlogBytes > 64 * 1024 * 1024)
    assert.ok(committed >= 64 && committed < 96)
    assert.equal(auto(f.db), 37)
    assert.equal(sync(f.db), 2)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM items').get().n, committed + 1)
    reader.exec('ROLLBACK'); reader.close(); reader = null
    await manager.withImportCheckpoints(f.db, async checkpoint => {
      const result = await checkpoint()
      assert.equal(result.log, result.checkpointed)
      f.db.exec('INSERT INTO items(payload) VALUES(NULL)')
    })
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM items').get().n, committed + 2)
    assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { reader?.close(); await manager.shutdownImportCheckpoints(); f.close() }
})

fixedTest('shutdown cooperatively closes workers, restores config and preserves active-import deletion guards', { timeout: 20000 }, async () => {
  const f = fixture(), manager = createImportCheckpointManager({ diagnostic: quiet }), entered = deferred(), finish = deferred()
  const task = manager.withImportCheckpoints(f.db, async checkpoint => {
    f.db.exec('INSERT INTO items(payload) VALUES(zeroblob(10000))')
    await checkpoint(); entered.resolve()
    await finish.promise
    assert.equal(await checkpoint(), null)
    assert.equal(auto(f.db), 37)
    f.db.exec('INSERT INTO items(payload) VALUES(NULL)')
  })
  try {
    await entered.promise
    await manager.shutdownImportCheckpoints()
    assert.equal(auto(f.db), 37)
    assert.equal(manager.importCheckpointActive(f.db), true)
    finish.resolve(); await task
    assert.equal(manager.importCheckpointActive(f.db), false)
    await manager.withImportCheckpoints(f.db, async checkpoint => { assert.equal(await checkpoint(), null); assert.equal(auto(f.db), 37) })
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM items').get().n, 2)
  } finally { finish.resolve(); await task; await manager.shutdownImportCheckpoints(); f.close() }
})
