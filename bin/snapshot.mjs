#!/usr/bin/env node
/**
 * Consistent snapshots of every SQLite database under a data root.
 *
 *   node bin/snapshot.mjs [DATA_ROOT] [OUT_DIR]
 *   node bin/snapshot.mjs /data /data/_snapshot        # inside the Docker container
 *
 * Why this exists: copying a live SQLite file — `cp`, `tar`, `docker cp`, a volume snapshot —
 * can capture a write in progress and produce an archive that restores to a corrupt database.
 * You find out on the day you need it. deploy/backup.sh has said so since it was written, and
 * used sqlite3's `.backup` accordingly; the Docker path in deploy/DEPLOY.md tarred the live
 * volume anyway, because the shipped image has node and no sqlite3 binary.
 *
 * `VACUUM INTO` is SQLite's own answer and needs nothing but node: it takes a read transaction and
 * writes a fresh, fully-checkpointed database file, so the snapshot carries no -wal and no -shm and
 * restores by being copied into place. Every snapshot is verified with PRAGMA quick_check before
 * this exits, because a backup nobody checked is a hope.
 *
 * Restoring: stop the app, put the file back, and REMOVE any stale -wal/-shm beside it — a
 * leftover write-ahead log from the crash you are recovering from will be replayed over the
 * database you just restored. See deploy/DEPLOY.md.
 */
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.argv[2] || process.env.DATA_ROOT || '/data')
const OUT = resolve(process.argv[3] || join(ROOT, '_snapshot'))
const die = (msg) => { console.error(`\n  ✗ ${msg}\n`); process.exit(1) }

try { if (!statSync(ROOT).isDirectory()) die(`${ROOT} is not a directory`) } catch { die(`${ROOT} does not exist`) }
if (OUT === ROOT) die('the snapshot directory must not be the data root itself')

// Never walk into the output directory, or a re-run snapshots its own previous snapshots — the
// mistake that quietly doubled deploy/backup.sh's archive every night.
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name)
  if (p === OUT) return []
  if (e.isDirectory()) return walk(p)
  return e.name.endsWith('.db') ? [p] : []
})

const dbs = walk(ROOT)
if (!dbs.length) die(`no .db files under ${ROOT} — nothing to back up, which is not a success`)

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

let bytes = 0
for (const src of dbs) {
  // Flattened, so tenants/acme/printshop.db and tenants/bobs/printshop.db cannot collide, and the
  // path each came from is still readable in the filename.
  const name = src.slice(ROOT.length + 1).replaceAll('/', '__')
  const dest = join(OUT, name)
  const db = new DatabaseSync(src, { readOnly: true })
  try { db.prepare('VACUUM INTO ?').run(dest) } finally { db.close() }
  const check = new DatabaseSync(dest, { readOnly: true })
  const ok = check.prepare('PRAGMA quick_check').get()?.quick_check
  check.close()
  if (ok !== 'ok') die(`${name} did not verify after snapshotting (${ok}) — this backup is not usable`)
  const size = statSync(dest).size
  bytes += size
  console.log(`  ✓ ${name}  ${(size / 1048576).toFixed(1)} MB  quick_check ok`)
}
console.log(`\n  ${dbs.length} database(s) → ${OUT}  (${(bytes / 1048576).toFixed(1)} MB)\n`)
