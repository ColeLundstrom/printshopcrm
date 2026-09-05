// This worker only checkpoints an existing database. Do not import db.mjs: importing it opens
// the default shop and runs migrations. Import transactions stay on their original connection.
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

let db
try {
  // mode=rw forbids CREATE, including a file removed between the main connection's filename
  // lookup and this open. A string URI preserves the query; a URL object is a filesystem path.
  const uri = new URL(workerData.uri)
  if (uri.protocol !== 'file:' || uri.search !== '?mode=rw' || uri.hash) throw Error('Invalid checkpoint database URI')
  db = new DatabaseSync(uri.href)
  db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA cache_size=-256; PRAGMA wal_autocheckpoint=0')
  const mode = db.prepare('PRAGMA journal_mode').get().journal_mode
  if (mode !== 'wal') throw Error('Checkpoint database is not in WAL mode')
  parentPort.postMessage({
    type: 'ready',
    version: db.prepare('SELECT sqlite_version() AS version').get().version,
    pageSize: db.prepare('PRAGMA page_size').get().page_size,
  })
  parentPort.on('message', message => {
    if (message?.type === 'close') {
      try { db.close() } finally { parentPort.close() }
      return
    }
    if (message?.type !== 'checkpoint' || !Number.isSafeInteger(message.id)) return
    const started = performance.now()
    try {
      // PASSIVE holds a checkpoint lock, never a writer lock, and never invokes busy_timeout.
      // An incomplete checkpoint is expected while a snapshot or another reader pins frames.
      const result = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
      parentPort.postMessage({ type: 'checkpoint', id: message.id, result, durationMs: performance.now() - started })
    } catch (error) {
      parentPort.postMessage({ type: 'checkpoint-error', id: message.id, error: String(error?.message || error) })
    }
  })
} catch (error) {
  try { db?.close() } catch { /* leave SQLite's WAL recovery files intact */ }
  parentPort.postMessage({ type: 'startup-error', error: String(error?.message || error) })
  parentPort.close()
}
