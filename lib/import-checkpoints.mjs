import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

const WORKER_URL = new URL('./import-checkpoint-worker.mjs', import.meta.url)
// Let Node inherit/filter its own worker options. Re-supplying process.execArgv makes Node 24's
// test-runner defaults (and ordinary process/V8 flags) fail ERR_WORKER_INVALID_EXEC_ARGV.
// A static ESM data entry also supports a parent launched with --input-type: that flag rejects
// a file entry, but is valid for a string entry. The only imported code is our local worker;
// database filenames remain structured workerData, never executable source.
const WORKER_ENTRY = new URL('data:text/javascript,' + encodeURIComponent('import ' + JSON.stringify(WORKER_URL.href) + ';'))
const MAX_BACKLOG = 64 * 1024 * 1024

// Older engines have a corruption race between WAL reset and concurrent checkpointing.
// https://sqlite.org/wal.html#the_wal_reset_bug . Require the current fixed release family;
// don't guess whether an older distribution has a private backport.
export function supportsImportCheckpointVersion(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version))
  if (!parts) return false
  const [major, minor, patch] = parts.slice(1).map(Number)
  if (![major, minor, patch].every(Number.isSafeInteger)) return false
  return major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3)))
}

export class ImportCheckpointBacklogError extends Error {
  constructor(backlogBytes) {
    super('Import paused after its last saved batch because an active database reader is keeping more than 64 MiB of import history pending. Let the other export or backup finish, then retry the same import file. The completed batches are still saved.')
    this.name = 'ImportCheckpointBacklogError'
    this.code = 'import_checkpoint_backlog'
    this.backlogBytes = backlogBytes
  }
}

export class ImportCheckpointRestoreError extends Error {
  constructor() {
    super('Import paused after its last saved batch because automatic database checkpoints could not be restored. Retry after the database connection recovers. The completed batches are still saved.')
    this.name = 'ImportCheckpointRestoreError'
    this.code = 'import_checkpoint_restore_failed'
  }
}

/**
 * One manager per server process. The factory also lets focused tests inject failed Workers
 * without production-only fault switches. The exported default manager has a hard two-worker
 * cap; additional simultaneous shops keep their ordinary SQLite automatic checkpoints.
 */
export function createImportCheckpointManager({
  createWorker = data => new Worker(WORKER_ENTRY, { workerData: data }),
  diagnostic = event => {
    if (event.event === 'fallback' || event.event === 'backlog' || process.env.PSC_IMPORT_DIAGNOSTICS === '1') {
      console.warn('[import-checkpoints]', JSON.stringify(event))
    }
  },
  startupTimeoutMs = 5000,
  checkpointTimeoutMs = 10000,
  closeTimeoutMs = 1000,
} = {}) {
  const byDb = new WeakMap(), states = new Set(), workers = new Set()
  let stopping = false
  const report = event => { try { diagnostic(event) } catch { /* logging must not fail imports */ } }
  const active = db => byDb.has(db)

  function cleanup(state) {
    if (state.leases || state.workerLive) return
    // An exited worker is not proof that automatic checkpoints were restored. Retain the saved
    // threshold on transient PRAGMA failure so shutdown or a later lease can still recover it.
    restore(state)
    if (state.enabled) return
    if (byDb.get(state.db) === state) byDb.delete(state.db)
    states.delete(state)
  }

  function restore(state) {
    if (!state.enabled) return
    try {
      state.db.exec(`PRAGMA wal_autocheckpoint=${state.originalAuto}`)
      state.enabled = false
    } catch (error) {
      // Closed/deleted handles cannot be restored. Keep the saved value so a later cleanup can
      // retry; importantly, don't turn a maintenance failure into a false import rollback.
      report({ event: 'fallback', reason: 'restore-failed', error: String(error?.message || error) })
    }
  }

  function restoreUnavailableWorker(state) {
    if (state.enabled && (state.failed || state.closing || !state.workerLive)) {
      restore(state)
      if (state.enabled) throw new ImportCheckpointRestoreError()
    }
  }

  function terminate(state) {
    if (!state.workerLive || state.terminating) return
    state.terminating = true
    try { Promise.resolve(state.worker.terminate()).catch(error => report({ event: 'fallback', reason: 'terminate-failed', error: String(error?.message || error) })) }
    catch (error) { report({ event: 'fallback', reason: 'terminate-failed', error: String(error?.message || error) }) }
    // Neither requesting termination nor an observation timeout releases capacity or the delete
    // guard. Only the Worker's actual exit event proves its database connection is gone.
  }

  function fallback(state, reason, error, stopWorker = true) {
    if (!state.failed) report({ event: 'fallback', reason, ...(error ? { error: String(error?.message || error).slice(0, 500) } : {}) })
    state.failed = true
    restore(state)
    if (state.pending) {
      const pending = state.pending; state.pending = null; clearTimeout(pending.timer)
      pending.resolve(null)
    }
    state.readyResolve?.()
    if (stopWorker) terminate(state)
  }

  function start(state) {
    if (stopping || String(process.env.PSC_IMPORT_CHECKPOINTS || '').toLowerCase() === 'off') return
    let uri
    try {
      const version = state.db.prepare('SELECT sqlite_version() AS version').get().version
      if (!supportsImportCheckpointVersion(version)) { report({ event: 'fallback', reason: 'sqlite-version', version }); return }
      const filename = state.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file
      if (!filename || state.db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') return
      // Keep the caller's synchronous setting untouched, including EXTRA (3). A connection that
      // has opted out of FULL durability is not silently reconfigured by this optimization.
      if (state.db.prepare('PRAGMA synchronous').get().synchronous < 2) return
      if (workers.size >= 2) { report({ event: 'fallback', reason: 'worker-capacity' }); return }
      uri = pathToFileURL(filename); uri.search = '?mode=rw'
    } catch (error) { fallback(state, 'database-unavailable', error, false); return }

    state.ready = new Promise(resolve => { state.readyResolve = resolve })
    state.done = new Promise(resolve => { state.doneResolve = resolve })
    try {
      state.worker = createWorker({ uri: uri.href })
      state.workerLive = true
      workers.add(state)
    } catch (error) {
      fallback(state, 'worker-startup', error, false)
      state.doneResolve()
      return
    }
    const startupTimer = setTimeout(() => fallback(state, 'worker-startup-timeout'), startupTimeoutMs)
    startupTimer.unref?.()
    state.worker.on('message', message => {
      if (message?.type === 'ready') {
        clearTimeout(startupTimer)
        if (state.failed || state.closing || state.wasReady) return
        state.wasReady = true
        try {
          if (!supportsImportCheckpointVersion(message.version) || !Number.isInteger(message.pageSize) || message.pageSize < 512 || message.pageSize > 65536) throw Error('Unsupported checkpoint worker database')
          if (state.db.prepare('PRAGMA synchronous').get().synchronous < 2) throw Error('Connection no longer uses FULL durability')
          // Read the threshold only now: another caller may have changed it while the worker
          // was opening. No database setting changes until the worker is actually ready.
          state.originalAuto = state.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint
          if (!Number.isSafeInteger(state.originalAuto) || state.originalAuto < 0) throw Error('Invalid automatic checkpoint threshold')
          state.db.exec('PRAGMA wal_autocheckpoint=0')
          state.enabled = true
          state.pageSize = message.pageSize
          report({ event: 'started', originalAuto: state.originalAuto, synchronous: state.db.prepare('PRAGMA synchronous').get().synchronous })
        } catch (error) { fallback(state, 'worker-configuration', error) }
        state.readyResolve()
      } else if (message?.type === 'startup-error') {
        clearTimeout(startupTimer)
        fallback(state, 'worker-startup', message.error)
      } else if ((message?.type === 'checkpoint' || message?.type === 'checkpoint-error') && state.pending?.id === message.id) {
        const pending = state.pending; state.pending = null; clearTimeout(pending.timer)
        if (message.type === 'checkpoint-error') {
          fallback(state, 'checkpoint-failed', message.error)
          pending.resolve(null)
          return
        }
        const result = message.result
        if (!result || ![result.busy, result.log, result.checkpointed].every(Number.isInteger) || result.log < -1 || result.checkpointed < -1) {
          fallback(state, 'checkpoint-protocol')
          pending.resolve(null)
          return
        }
        pending.resolve({ ...result, pageSize: state.pageSize, durationMs: message.durationMs })
      }
    })
    state.worker.on('error', error => {
      clearTimeout(startupTimer)
      fallback(state, 'worker-error', error)
    })
    state.worker.on('exit', code => {
      clearTimeout(startupTimer)
      state.workerLive = false
      workers.delete(state)
      if (!state.closing && !state.failed) fallback(state, 'worker-exit', `exit ${code}`, false)
      restore(state)
      state.readyResolve()
      state.doneResolve()
      cleanup(state)
    })
  }

  function sendCheckpoint(state) {
    if (!state.enabled || state.failed || state.closing || !state.workerLive) return Promise.resolve(null)
    return new Promise(resolve => {
      const id = ++state.sequence
      const timer = setTimeout(() => fallback(state, 'checkpoint-timeout'), checkpointTimeoutMs)
      timer.unref?.()
      state.pending = { id, resolve, timer }
      try { state.worker.postMessage({ type: 'checkpoint', id }) }
      catch (error) { fallback(state, 'checkpoint-send', error) }
    })
  }

  function checkpoint(state) {
    // The ordinary fallback is safe only once the original automatic threshold is restored.
    // A persistent restore failure must stop at the caller's post-COMMIT boundary, instead of
    // silently letting an arbitrarily large import grow its WAL with no checkpointer at all.
    try { restoreUnavailableWorker(state) } catch (error) { return Promise.reject(error) }
    if (!state.enabled || state.failed || state.closing) return Promise.resolve(null)
    state.requested++
    if (state.pump) return state.pump
    // At most one message is in flight and one more pass is demanded, regardless of how many
    // simultaneous import callbacks commit batches. Requests arriving after a pass starts cause
    // a subsequent pass, so their newly committed frames are not mistaken for already drained.
    state.pump = (async () => {
      let result
      do {
        const requested = state.requested
        result = await sendCheckpoint(state)
        if (!result) { restoreUnavailableWorker(state); return null }
        const backlogBytes = Math.max(0, result.log - result.checkpointed) * (state.pageSize + 24)
        report({ event: 'checkpoint', ...result, backlogBytes })
        if (backlogBytes > MAX_BACKLOG) {
          report({ event: 'backlog', backlogBytes })
          throw new ImportCheckpointBacklogError(backlogBytes)
        }
        if (requested === state.requested) return result
      } while (state.enabled && !state.failed && !state.closing)
      return result
    })().finally(() => { state.pump = null })
    return state.pump
  }

  async function close(state) {
    if (state.closing) { restore(state); cleanup(state); return state.closePromise }
    state.closing = true
    restore(state)
    if (!state.workerLive) { cleanup(state); return }
    state.closePromise = (async () => {
      try { state.worker.postMessage({ type: 'close' }) }
      catch (error) { fallback(state, 'worker-close', error) }
      let timer
      await Promise.race([
        state.done,
        new Promise(resolve => {
          timer = setTimeout(() => { report({ event: 'fallback', reason: 'worker-close-timeout' }); terminate(state); resolve() }, closeTimeoutMs)
          timer.unref?.()
        }),
      ])
      clearTimeout(timer)
      cleanup(state)
    })()
    return state.closePromise
  }

  async function withCheckpoints(db, callback) {
    let state = byDb.get(db)
    if (state && !state.leases && !state.workerLive) {
      // This may be a retained recovery record. Never start a replacement worker that would
      // capture the temporary zero threshold as though it were the shop's original setting.
      cleanup(state)
      state = byDb.get(db)
    }
    if (!state) {
      state = { db, leases: 0, ready: Promise.resolve(), sequence: 0, requested: 0, workerLive: false, enabled: false }
      byDb.set(db, state); states.add(state)
      // Publish the lease before starting a worker so deletion cannot slip into the ready await.
      state.leases++
      start(state)
    } else state.leases++
    try {
      await state.ready
      return await callback(() => checkpoint(state))
    } finally {
      state.leases--
      if (!state.leases) {
        try { await checkpoint(state) } catch { /* the caller already receives batch backlog errors */ }
        // Another import may have leased this connection during the final asynchronous pass.
        if (!state.leases) await close(state)
      }
      cleanup(state)
    }
  }

  async function shutdown() {
    stopping = true
    await Promise.all([...states].map(async state => {
      // Shutdown drains maintenance, never keeps automatic checkpoints disabled while waiting
      // for HTTP callbacks. Existing imports may finish safely with their original threshold.
      restore(state)
      try { await state.pump } catch { /* not an import rollback */ }
      await close(state)
    }))
  }

  return { withImportCheckpoints: withCheckpoints, importCheckpointActive: active, shutdownImportCheckpoints: shutdown }
}

const manager = createImportCheckpointManager()
export const withImportCheckpoints = manager.withImportCheckpoints
export const importCheckpointActive = manager.importCheckpointActive
export const shutdownImportCheckpoints = manager.shutdownImportCheckpoints
