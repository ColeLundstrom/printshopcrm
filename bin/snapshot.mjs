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
//
// …and never into `backups/` or `_snapshot/` either, wherever they sit under the root. OUT is a
// NEW timestamped directory on every deploy, so excluding only OUT excluded nothing: the second
// pre-deploy snapshot backed up the first one, the third backed up both, and the fourth's archive
// was mostly copies of itself. release.sh, restore.mjs and backup.sh all prune exactly these two
// names already; this was the one walker that did not.
const SKIP_DIRS = new Set(['backups', '_snapshot'])
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name)
  if (p === OUT) return []
  if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walk(p)
  return e.name.endsWith('.db') ? [p] : []
})

const dbs = walk(ROOT)
if (!dbs.length) die(`no .db files under ${ROOT} — nothing to back up, which is not a success`)

// Two sources cannot share one destination name. `tenants/acme/printshop.db` flattens to
// `tenants__acme__printshop.db` — and a botched single-file restore leaves a file of exactly that
// name sitting in the data root, so both flatten to the same thing. VACUUM INTO refuses an
// existing file, so the old code died mid-loop with a raw SQLite stack, having ALREADY rm -rf'd
// the previous snapshot. Detect it before anything is deleted, and name both paths.
const byName = new Map()
for (const src of dbs) {
  const name = src.slice(ROOT.length + 1).replaceAll('/', '__')
  if (byName.has(name)) die(`two databases would be snapshotted to the same file "${name}":\n      ${byName.get(name)}\n      ${src}\n    Rename or remove one of them — nothing has been changed.`)
  byName.set(name, src)
}

rmSync(OUT, { recursive: true, force: true })
/*
 * The first write is the one that fails, and this is the worst possible moment for this file to
 * stop speaking English.
 *
 * INSTALL.md's upgrade block runs `sudo -u printshopcrm npm run snapshot -- /var/lib/printshopcrm
 * /var/backups/pre-upgrade-<stamp>`, and /var/backups on a stock Ubuntu box is root-owned 0755. So
 * the documented pre-migration backup — the ONLY backup the documented upgrade takes — died with
 * a raw `Error: EACCES: permission denied, mkdir` and a Node stack, exit 1.
 *
 * The lines in that block are not &&-chained, so the paste continues straight into `git pull`,
 * `npm ci` and `systemctl restart`, which runs every schema migration and every one-shot data
 * restatement against every shop with nothing to go back to.
 *
 * bin/restore.mjs was given exactly this treatment for exactly this call, and said so in its own
 * comment. The half the upgrade actually runs never got it.
 */
try { mkdirSync(OUT, { recursive: true }) } catch (e) {
  die(`cannot write the snapshot into ${OUT} — ${e.code || e.message}.\n` +
    `    Run this as the user that owns the data, or pick a directory it can write:\n` +
    `      sudo -u <service-user> node ${process.argv[1]} ${process.argv.slice(2).join(' ')}\n` +
    `    Nothing has been backed up, and nothing has been changed. Do not upgrade until this works.`)
}

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
