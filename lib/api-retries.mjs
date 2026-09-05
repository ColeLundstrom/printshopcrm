import { createHash } from 'node:crypto'

export const API_RETRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_create_receipts (
  principal TEXT NOT NULL,
  operation TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal, operation, key_hash)
);`

const hash = value => createHash('sha256').update(value).digest('hex')
// JSON object field order does not change the meaning of a request. Array order and
// scalar types do; a changed quote must never silently replay the previous quote.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const createResult = (status, body) => ({ status, body })

/** A synchronous shop-local transaction. No network calls or awaits inside create. */
export function createWithRetry(db, { principal, operation, key, body }, create) {
  if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key))) {
    return createResult(400, { error: 'Idempotency-Key must contain 8–128 letters, digits, dots, colons, underscores or hyphens.', code: 'invalid_idempotency_key' })
  }
  const keyHash = key === undefined ? null : hash(key)
  const requestHash = keyHash ? hash(JSON.stringify(canonical(body ?? {}))) : null
  db.exec('BEGIN IMMEDIATE')
  try {
    if (keyHash) {
      const previous = db.prepare('SELECT * FROM api_create_receipts WHERE principal=? AND operation=? AND key_hash=?').get(principal, operation, keyHash)
      if (previous) {
        db.exec('ROLLBACK')
        if (previous.request_hash !== requestHash) return createResult(409, { error: 'This Idempotency-Key was already used with a different request. Use a new key for a new operation.', code: 'idempotency_conflict' })
        return { status: previous.response_status, body: JSON.parse(previous.response_json), replayed: true }
      }
    }
    const afterCommit = []
    const result = create(fn => afterCommit.push(fn))
    if (!result || typeof result.then === 'function' || !Number.isInteger(result.status)) throw Error('API creation must return a synchronous result')
    if (result.status < 200 || result.status >= 300) { db.exec('ROLLBACK'); return result }
    const responseJson = JSON.stringify(result.body)
    if (keyHash) db.prepare('INSERT INTO api_create_receipts (principal,operation,key_hash,request_hash,response_status,response_json,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(principal, operation, keyHash, requestHash, result.status, responseJson, new Date().toISOString())
    db.exec('COMMIT')
    return { ...result, replayed: false, afterCommit }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* Preserve the original failure. */ }
    throw error
  }
}
