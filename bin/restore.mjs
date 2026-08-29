#!/usr/bin/env node
/**
 * Put a backup back. The other half of bin/snapshot.mjs and deploy/backup.sh.
 *
 *   node bin/restore.mjs <backup>                      # say what WOULD happen, change nothing
 *   node bin/restore.mjs <backup> --yes                # do it
 *   node bin/restore.mjs <backup> --to /var/lib/printshopcrm/printshop.db --yes
 *   node bin/restore.mjs <backup> --data-root /var/lib/printshopcrm --yes
 *
 * <backup> is whatever you have:
 *   · one .db file                       — restored to --to, or to PSC_DB
 *   · a directory from deploy/backup.sh  — printshop.db, control.db, tenants/<slug>/printshop.db
 *   · a directory from bin/snapshot.mjs  — the same, flattened: tenants__acme__printshop.db
 *   · an unpacked nightly archive        — the _snapshot/ or the dated directory inside it
 *
 * WHY THIS FILE EXISTS
 *
 * Until now the product's only in-place restore instruction was one line printed by
 * deploy/release.sh:
 *
 *     sudo systemctl stop psc && cp '<backup>/x.db' '<data>/x.db' && sudo systemctl start psc
 *
 * — contradicted twenty-eight lines above it in the same script, which says in as many words that
 * a stale -wal beside a restored database "is worse than none". It is not a nitpick. Every
 * PrintShopCRM database runs in WAL mode (lib/db.mjs: `PRAGMA journal_mode = WAL`), so a crash —
 * the thing you are recovering FROM — leaves printshop.db-wal on disk holding committed frames.
 * `cp` replaces the .db and leaves that log sitting next to it. SQLite validates a WAL by its own
 * internal checksums, not against the database it is beside, so on the next start it replays the
 * crash-time log straight over the file you just restored and truncates it to the crash-time page
 * count. Measured, from a 500-customer backup:
 *
 *     $ cp backup.db live.db          # exit 0, no output
 *     $ sqlite3 live.db 'PRAGMA quick_check; SELECT count(*) FROM customers'
 *     ok
 *     0
 *
 * Green, silent, and the shop is empty. This tool makes that outcome unreachable:
 *
 *   1. it verifies the BACKUP before touching anything — a corrupt backup never overwrites a
 *      live database;
 *   2. it refuses to run while something still holds the database open;
 *   3. it takes its own safety copy of what is being replaced, INCLUDING the -wal, so a restore
 *      is itself undoable;
 *   4. it moves the stale -wal/-shm aside rather than leaving or silently deleting them;
 *   5. it verifies the restored file and reports the row counts you can recognise;
 *   6. it puts the original owner and mode back, so a `sudo` restore does not leave the service
 *      with a database it cannot write to;
 *   7. and it changes nothing at all without --yes.
 */
import { DatabaseSync } from 'node:sqlite'
import {
  statSync, readdirSync, mkdirSync, copyFileSync, renameSync, existsSync,
  chownSync, chmodSync,
} from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'

/* ------------------------------------------------------------------ args */
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name, fallback = '') => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--to', '--data-root'].includes(argv[i - 1]))

const APPLY = flag('--yes')
const FORCE = flag('--force')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

const out = []
const say = (s = '') => { out.push(s); console.log(s) }
const die = (msg, hint = '') => {
  console.error(`\n  ✗ ${msg}`)
  if (hint) console.error(`    ${hint}`)
  console.error('')
  process.exit(1)
}

if (!positional.length || flag('--help') || flag('-h')) {
  console.log(`
  Restore a PrintShopCRM backup.

    node bin/restore.mjs <backup>                 show the plan, change nothing
    node bin/restore.mjs <backup> --yes           carry it out

  <backup> is a .db file, a directory from deploy/backup.sh, or one from bin/snapshot.mjs.

    --to <file>          restore a single .db to exactly this path
    --data-root <dir>    restore a directory of databases into this data root
                         (default: \$DATA_ROOT, else the directory holding \$PSC_DB,
                          else /var/lib/printshopcrm)
    --force              proceed even though the database still looks open
                         (stop the service first instead — this is here for a wedged lock)
    --keep-wal           do NOT move the existing -wal aside. Almost never right; the stale
                         write-ahead log is the thing that silently empties a restore.

  Stop the app first:   sudo systemctl stop printshopcrm
  Start it after:       sudo systemctl start printshopcrm
`)
  process.exit(positional.length ? 0 : 1)
}

const SRC = resolve(positional[0])
if (!existsSync(SRC)) die(`no such backup: ${SRC}`)

/* ---------------------------------------------------- where things go */
const DEFAULT_ROOT = process.env.DATA_ROOT
  || (process.env.PSC_DB ? dirname(resolve(process.env.PSC_DB)) : '')
  || '/var/lib/printshopcrm'
const DATA_ROOT = resolve(opt('--data-root', DEFAULT_ROOT))

/**
 * Work out every (source file → live file) pair.
 *
 * deploy/backup.sh mirrors the data root; bin/snapshot.mjs flattens it with `__` separators so
 * two shops' printshop.db cannot collide. Both are read here, because the shop owner has whichever
 * one their install happened to produce and should not have to know which.
 */
const isDb = (n) => n.endsWith('.db')
function planFor(src) {
  const st = statSync(src)
  if (st.isFile()) {
    if (!isDb(src)) die(`${src} is not a .db file`, 'Unpack the archive first:  tar xzf <archive>.tar.gz')
    const to = opt('--to') ? resolve(opt('--to')) : join(DATA_ROOT, basename(src))
    return [{ from: src, to }]
  }
  if (opt('--to')) die('--to takes a single .db file; use --data-root for a directory of them')

  const pairs = []
  const walk = (dir, rel = '') => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      // Never descend into a backups directory inside the source: deploy/release.sh's
      // pre-migration snapshots live there, and restoring THOSE over the live install is not what
      // anybody means by "restore last night's backup".
      if (e.isDirectory()) { if (!rel && e.name === 'backups') continue; walk(p, rel ? `${rel}/${e.name}` : e.name); continue }
      if (!isDb(e.name)) continue
      // bin/snapshot.mjs flattens `tenants/acme/printshop.db` to `tenants__acme__printshop.db`.
      const relPath = e.name.includes('__') ? e.name.replaceAll('__', '/') : (rel ? `${rel}/${e.name}` : e.name)
      pairs.push({ from: p, to: join(DATA_ROOT, relPath) })
    }
  }
  walk(src)
  if (!pairs.length) die(`no .db files under ${src}`, 'If this is a nightly archive, unpack it first:  tar xzf <archive>.tar.gz')
  return pairs.sort((a, b) => a.to.localeCompare(b.to))
}

/* ------------------------------------------------------- verification */
const quickCheck = (path) => {
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const r = db.prepare('PRAGMA quick_check').get()?.quick_check
    return r === 'ok' ? { ok: true } : { ok: false, error: String(r) }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  } finally { try { db?.close() } catch { /* already closed */ } }
}

/** Row counts a shop owner can recognise as their own shop, rather than a page count. */
const RECOGNISABLE = ['customers', 'invoices', 'estimates', 'jobs', 'tenants', 'members']
function census(path) {
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
    return RECOGNISABLE.filter((t) => have.has(t))
      .map((t) => `${db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n} ${t}`)
      .join(', ') || 'no recognisable tables'
  } catch (e) {
    return `unreadable (${String(e?.message || e)})`
  } finally { try { db?.close() } catch { /* already closed */ } }
}

/**
 * Is anything still using this database?
 *
 * A restore over a running service corrupts the file AND is invisible: the service keeps serving
 * from its own page cache and writes it back afterwards. This is the guard the whole tool leans
 * on, and it needs no systemd, so it works the same in Docker, on Fly, and on a laptop.
 *
 * It used to be BEGIN EXCLUSIVE, which is the right answer for a rollback-journal database and
 * NO answer at all here. SQLite documents EXCLUSIVE as behaving exactly like IMMEDIATE in WAL
 * mode, and every PrintShopCRM database is WAL (lib/db.mjs: `PRAGMA journal_mode = WAL`) — so it
 * only ever collided with another connection mid-WRITE. A running app holds an open, idle handle
 * between requests, which is almost all of the time, so the probe said "free" and the restore
 * went ahead. Measured against a live server: the restore completed, the app then took 116
 * committed writes, reported zero errors, and read back 124 contacts from a file that had 8 on
 * disk and passed quick_check. Two divergent copies of a shop, one of them in RAM, and nothing
 * anywhere saying so.
 *
 * `PRAGMA locking_mode = EXCLUSIVE` is the WAL-correct question: it takes the WAL's locks
 * outright on the first access and fails with SQLITE_BUSY if any other connection has the
 * database open at all, idle or not. Verified both directions — BUSY with a live handle open,
 * free the moment it closes.
 */
function looksOpen(path) {
  if (!existsSync(path)) return false
  let db
  try {
    db = new DatabaseSync(path)
    db.exec('PRAGMA busy_timeout = 500')
    db.exec('PRAGMA locking_mode = EXCLUSIVE')
    // locking_mode is lazy — it takes the lock on the next access, not on the PRAGMA itself.
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get()
    return false
  } catch (e) {
    return /busy|locked/i.test(String(e?.message || e))
  } finally { try { db?.close() } catch { /* already closed */ } }
}

/* ------------------------------------------------------------- plan */
const pairs = planFor(SRC)
// Under $DATA_ROOT/backups/, deliberately: deploy/release.sh already puts its pre-migration
// snapshots there and deploy/backup.sh prunes that one subtree out of the nightly archive. A
// safety copy anywhere else in the data root would be re-archived every night forever.
const SAFETY = join(DATA_ROOT, 'backups', `pre-restore-${stamp}`)

say('')
say(`  Restore plan`)
say(`    from       ${SRC}`)
say(`    data root  ${DATA_ROOT}`)
say(`    safety     ${SAFETY}`)
say('')

let bad = 0
let busy = 0
for (const p of pairs) {
  const v = quickCheck(p.from)
  const live = existsSync(p.to)
  const stale = ['-wal', '-shm'].filter((s) => existsSync(p.to + s))
  const walBytes = existsSync(p.to + '-wal') ? statSync(p.to + '-wal').size : 0
  const open = live && looksOpen(p.to)
  if (!v.ok) bad++
  if (open) busy++
  say(`    ${v.ok ? '✓' : '✗'} ${p.from.slice(SRC.length + 1) || basename(p.from)}`)
  say(`        ${v.ok ? census(p.from) : `BACKUP IS NOT USABLE: ${v.error}`}`)
  say(`        → ${p.to}${live ? '' : '   (new file)'}`)
  if (live) say(`        replacing: ${census(p.to)}`)
  if (stale.length) {
    say(`        a ${stale.join(' and ')} is beside it${walBytes ? ` (${walBytes} bytes of write-ahead log)` : ''}`)
    say(`        → moved into the safety copy. Left in place it would replay over the restore${walBytes ? ' — this is the one that empties a shop' : ''}.`)
  }
  if (open) say(`        STILL OPEN — something is using this database`)
}
say('')

/* --------------------------------------------------------- refusals */
if (bad) {
  die(`${bad} of ${pairs.length} file(s) in this backup did not pass PRAGMA quick_check.`,
    'Nothing was touched. Use an older archive — restoring a corrupt backup over a live database\n    would turn one bad day into two.')
}
if (busy && !FORCE) {
  die(`${busy} database(s) are still open — stop the app first.`,
    'sudo systemctl stop printshopcrm      (Docker:  docker compose stop app)\n'
    + '    Restoring under a running service corrupts the file and the service writes its own stale\n'
    + '    pages back over yours afterwards. --force overrides this; it is almost never right.')
}
if (!APPLY) {
  say('  Nothing has been changed. Re-run with --yes to carry this out:')
  say('')
  say(`    node bin/restore.mjs ${positional[0]}${opt('--to') ? ` --to ${opt('--to')}` : ''}${opt('--data-root') ? ` --data-root ${opt('--data-root')}` : ''} --yes`)
  say('')
  process.exit(0)
}

/* ------------------------------------------------------------- do it */
mkdirSync(SAFETY, { recursive: true })
let restored = 0
const undo = []

for (const p of pairs) {
  const rel = p.to.slice(DATA_ROOT.length + 1) || basename(p.to)
  const keepDir = join(SAFETY, dirname(rel))
  mkdirSync(keepDir, { recursive: true })
  mkdirSync(dirname(p.to), { recursive: true })

  // Preserve the identity of the file we are replacing. A `sudo node bin/restore.mjs` otherwise
  // leaves root-owned databases behind and the service — which runs as an unprivileged user, see
  // deploy/printshopcrm.service — comes back up with "attempt to write a readonly database" on
  // every save. That is INSTALL.md's "Permission denied writing the database", caused by the fix.
  let own = null
  if (existsSync(p.to)) {
    const st = statSync(p.to)
    own = { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 }
    // The safety copy is a plain byte copy, ON PURPOSE: the live file may be the corrupt one, and
    // a VACUUM INTO of a corrupt database fails, which would leave us with no copy at all.
    copyFileSync(p.to, join(SAFETY, rel))
    undo.push({ back: join(SAFETY, rel), to: p.to })
  }

  // The -wal and the -shm go with it. MOVED, not deleted: the -wal may be the only place the last
  // few minutes of the shop's work exists, and a restore should never be the thing that destroys
  // it. Leaving it in place is what silently empties the restored database.
  for (const suffix of ['-wal', '-shm']) {
    const side = p.to + suffix
    if (!existsSync(side)) continue
    if (flag('--keep-wal')) { say(`    ! keeping ${basename(side)} in place because --keep-wal was given`); continue }
    renameSync(side, join(SAFETY, rel + suffix))
  }

  copyFileSync(p.from, p.to)
  if (own) { try { chownSync(p.to, own.uid, own.gid); chmodSync(p.to, own.mode) } catch { /* not privileged; leave as copied */ } }

  const v = quickCheck(p.to)
  if (!v.ok) {
    // Put it back rather than leave a shop with a database that does not open.
    try { if (existsSync(join(SAFETY, rel))) copyFileSync(join(SAFETY, rel), p.to) } catch { /* nothing better to do */ }
    die(`${p.to} did not verify after being restored (${v.error}) — the previous file has been put back.`,
      `Everything taken aside is in ${SAFETY}`)
  }
  restored++
  say(`  ✓ ${p.to}`)
  say(`      ${census(p.to)}   quick_check ok`)
}

say('')
say(`  Restored ${restored} database(s).`)
say(`  What was replaced is in ${SAFETY} — including any -wal, so this is undoable:`)
say('')
for (const u of undo.slice(0, 3)) say(`      cp '${u.back}' '${u.to}'`)
if (undo.length > 3) say(`      … and ${undo.length - 3} more`)
say('')
say('  Start the app and check it:')
say('')
say('      sudo systemctl start printshopcrm')
say('      curl -fsS http://127.0.0.1:${PORT:-3333}/health')
say('')
say(`  When the shop looks right, delete ${SAFETY}. Not before.`)
say('')
