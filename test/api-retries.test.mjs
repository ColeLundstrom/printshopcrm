import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_RETRY_SCHEMA, createWithRetry, createResult } from '../lib/api-retries.mjs'

test('creation receipts survive restart and roll back domain writes on failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-retries-')), path = join(dir, 'shop.db')
  let db = new DatabaseSync(path)
  try {
    db.exec(API_RETRY_SCHEMA + 'CREATE TABLE records(id INTEGER PRIMARY KEY, name TEXT)')
    let hooks = 0
    const create = afterCommit => {
      const id = Number(db.prepare('INSERT INTO records(name) VALUES (?)').run('Draft').lastInsertRowid)
      afterCommit(() => hooks++)
      return createResult(201, { id, status: 'draft' })
    }
    const args = { principal: 'agent:1', operation: 'estimates', key: 'request-12345678', body: { customer: { name: 'Shop' }, items: [1, 2] } }
    let first = createWithRetry(db, args, create)
    first.afterCommit.forEach(fn => fn()); assert.equal(hooks, 1)
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM api_create_receipts').all()).includes(args.key))
    db.close(); db = new DatabaseSync(path)
    const replay = createWithRetry(db, { ...args, body: { items: [1, 2], customer: { name: 'Shop' } } }, create)
    assert.equal(replay.replayed, true); assert.deepEqual(replay.body, first.body); assert.equal(replay.afterCommit, undefined)
    assert.equal(createWithRetry(db, { ...args, body: { items: [2, 1], customer: { name: 'Shop' } } }, create).status, 409)
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 1)
    assert.equal(createWithRetry(db, { ...args, principal: 'agent:2' }, create).replayed, false)
    assert.equal(createWithRetry(db, { ...args, operation: 'customers' }, create).replayed, false)
    assert.equal(createWithRetry(db, { ...args, key: '' }, create).status, 400)
    const invalid = createWithRetry(db, { ...args, key: 'rejected-123' }, afterCommit => { create(afterCommit); return createResult(400, { error: 'bad items' }) })
    assert.equal(invalid.status, 400); assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 3)
    assert.equal(db.prepare('SELECT count(*) n FROM api_create_receipts').get().n, 3)
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON api_create_receipts BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END")
    assert.throws(() => createWithRetry(db, { ...args, key: 'retry-after-crash' }, create), /fixture receipt failure/)
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 3)
    db.exec('DROP TRIGGER fail_receipt')
    assert.equal(createWithRetry(db, { ...args, key: 'retry-after-crash' }, create).status, 201)
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 4)
    assert.equal(createWithRetry(db, { ...args, key: undefined }, create).status, 201)
    assert.equal(createWithRetry(db, { ...args, key: undefined }, create).status, 201)
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 6)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
