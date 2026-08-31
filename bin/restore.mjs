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
 *   7. it puts the ARTWORK back too, and refuses to call a restore finished if the backup has
 *      none — deploy/backup.sh writes uploads.tar.gz beside the databases, and this tool used to
 *      walk straight past it and print "✓ Restored 2 database(s)". The app came back up healthy
 *      and every proof, mockup and shop logo was a broken image, with nothing on any screen
 *      saying the files were gone;
 *   8. and it changes nothing at all without --yes.
 */
import { DatabaseSync } from 'node:sqlite'
import {
  statSync, readdirSync, mkdirSync, copyFileSync, renameSync, rmSync, existsSync,
  chownSync, chmodSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
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
    --skip-art           restore the databases only, leaving the artwork on disk as it is.
                         Say so deliberately; the default is to put the art back too.

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
    /**
     * Un-flatten a single file too.
     *
     * bin/snapshot.mjs writes `tenants/acme/printshop.db` as `tenants__acme__printshop.db`, and
     * the directory walk below has always turned that back into a path. This branch did not — it
     * used basename() — so the documented single-shop restore
     *
     *   node bin/restore.mjs backups/…/tenants__acme__printshop.db --yes
     *
     * wrote 501 customers to `<data-root>/tenants__acme__printshop.db`, a path the app never
     * opens, and printed "Restored 1 database(s) … quick_check ok" and exit 0. The shop was still
     * empty. Exercised end to end; four rounds open.
     *
     * The stray file it left behind is the second-order half: the nightly then archives it ("5
     * database(s)"), and the next FULL restore has two sources landing on one destination — the
     * stale copy wins silently and the shop loses today's work. bin/snapshot.mjs now refuses that
     * collision by name rather than dying halfway through.
     *
     * --to is unchanged and still wins: it is the escape for a file whose name says nothing.
     */
    const flat = basename(src)
    const rel = flat.includes('__') ? flat.replaceAll('__', '/') : flat
    const to = opt('--to') ? resolve(opt('--to')) : join(DATA_ROOT, rel)
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
// `customers` was on this list, and there has never been such a table in this product — the
// customer book is `contacts` (lib/db.mjs), which bin/reset.mjs's own survey already gets right.
// census() filters the list down to tables that exist, so the miss was silent: a shop that had
// migrated a 3,180-name customer book and not yet written a quote was told "0 invoices,
// 0 estimates, 0 jobs" about a completely intact backup. `payments` was never listed at all, so
// nothing printed could tell a restore that brought the money ledger back from one that did not.
const RECOGNISABLE = ['contacts', 'invoices', 'estimates', 'payments', 'jobs', 'tenants', 'members']
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
 *
 * THIS FUNCTION MUTATES THE FILE IT PROBES. There is no read-only way to ask the question: a
 * read-only handle plus locking_mode = EXCLUSIVE throws "disk I/O error" against a live database,
 * which is indistinguishable from a dozen real faults. A read-WRITE open performs WAL recovery,
 * and closing the last connection checkpoints the log into the main file and deletes it. So the
 * probe rewrites exactly the bytes this tool exists to preserve, and it must never run during a
 * plan or before the safety copy. Both of those had happened; see the preserve phase below.
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

/**
 * Customer artwork, which is the half of a backup that is not a database.
 *
 * deploy/backup.sh writes `uploads.tar.gz` beside the databases and counts the files into it, and
 * this tool used to walk straight past it: a documented restore printed "✓ Restored 2
 * database(s)", the app came back up healthy, and every proof, every mockup and the shop's own
 * logo was a broken image. Reproduced end to end — backup, wipe, restore — with zero artwork on
 * disk afterwards and nothing on any screen saying where it went.
 *
 * Accepts either the archive or an already-unpacked `uploads/` directory, because an operator who
 * has untarred the nightly by hand should not be told their backup is incomplete.
 */
const ART_LIVE = join(DATA_ROOT, 'uploads')
const artSource = (() => {
  try { if (!statSync(SRC).isDirectory()) return null } catch { return null }
  for (const name of ['uploads.tar.gz', 'uploads.tgz']) {
    const p = join(SRC, name)
    if (existsSync(p)) return { kind: 'archive', path: p }
  }
  const dir = join(SRC, 'uploads')
  try { if (statSync(dir).isDirectory()) return { kind: 'directory', path: dir } } catch { /* not there */ }
  return null
})()
const countArt = (dir) => {
  let n = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else n++
    }
  }
  try { walk(dir) } catch { /* unreadable — reported as 0 */ }
  return n
}

say('')
say(`  Restore plan`)
say(`    from       ${SRC}`)
say(`    data root  ${DATA_ROOT}`)
say(`    safety     ${SAFETY}`)
say('')

let bad = 0
for (const p of pairs) {
  const v = quickCheck(p.from)
  const live = existsSync(p.to)
  const stale = ['-wal', '-shm'].filter((s) => existsSync(p.to + s))
  const walBytes = existsSync(p.to + '-wal') ? statSync(p.to + '-wal').size : 0
  if (!v.ok) bad++
  say(`    ${v.ok ? '✓' : '✗'} ${p.from.slice(SRC.length + 1) || basename(p.from)}`)
  say(`        ${v.ok ? census(p.from) : `BACKUP IS NOT USABLE: ${v.error}`}`)
  say(`        → ${p.to}${live ? '' : '   (new file)'}`)
  if (live) say(`        replacing: ${census(p.to)}`)
  if (stale.length) {
    say(`        a ${stale.join(' and ')} is beside it${walBytes ? ` (${walBytes} bytes of write-ahead log)` : ''}`)
    say(`        → moved into the safety copy. Left in place it would replay over the restore${walBytes ? ' — this is the one that empties a shop' : ''}.`)
  }
}

if (flag('--skip-art')) {
  say(`    · artwork left alone (--skip-art)`)
} else if (artSource) {
  const live = existsSync(ART_LIVE) ? countArt(ART_LIVE) : 0
  say(`    ✓ ${artSource.kind === 'archive' ? basename(artSource.path) : 'uploads/'}`)
  say(`        → ${ART_LIVE}${live ? `   (replacing ${live} file(s), moved into the safety copy)` : '   (new)'}`)
} else {
  // The loud half. A database-only restore looks completely healthy and is missing every proof.
  say(`    ✗ NO ARTWORK IN THIS BACKUP`)
  say(`        ${ART_LIVE} will be left exactly as it is.`)
  say(`        If this backup is all you have, every proof, mockup and shop logo the databases`)
  say(`        still point at is a broken image with nothing on screen to explain it.`)
}
say('')

/* --------------------------------------------------------- refusals */
if (bad) {
  die(`${bad} of ${pairs.length} file(s) in this backup did not pass PRAGMA quick_check.`,
    'Nothing was touched. Use an older archive — restoring a corrupt backup over a live database\n    would turn one bad day into two.')
}
if (!APPLY) {
  // Deliberately NOT the still-open probe. See the note on looksOpen(): asking the question
  // MUTATES the file, so a plan cannot ask it. The probe runs under --yes, once the bytes are safe.
  say('  Whether anything still has these databases open is checked when you use --yes —')
  say('  asking that question opens the file, and a plan does not open anything. Stop the app first.')
  say('')
  say('  Nothing has been changed. Re-run with --yes to carry this out:')
  say('')
  say(`    node bin/restore.mjs ${positional[0]}${opt('--to') ? ` --to ${opt('--to')}` : ''}${opt('--data-root') ? ` --data-root ${opt('--data-root')}` : ''} --yes`)
  say('')
  process.exit(0)
}

/* ------------------------------------------------------------- do it */
/**
 * The first write is the one that fails, and it used to fail as a raw EACCES stack trace — after
 * the operator has already stopped the service and typed --yes. That is the worst possible moment
 * for this file to stop speaking English: the shop is down, the person at the keyboard has no
 * developer, and the message names a Node internal.
 *
 * INSTALL.md's own emergency block gives the command without a `sudo`, so this is the ordinary
 * path, not an unlucky one.
 */
try { mkdirSync(SAFETY, { recursive: true }) } catch (e) {
  die(`cannot write the safety copy into ${SAFETY} — ${e.code || e.message}`,
    `Run this as the user that owns the data directory, or with sudo:\n      sudo node ${process.argv[1]} ${process.argv.slice(2).join(' ')}\n    Nothing has been changed.`)
}
let restored = 0
const undo = []

/**
 * Preserve every byte BEFORE anything opens a live database. Two separate defects made this a
 * phase of its own rather than the first few lines of the loop below.
 *
 * looksOpen() opens the file read-write. A read-write open of a WAL database performs WAL
 * recovery, and closing the last connection checkpoints the log into the main file and removes
 * it. So the probe rewrote the very bytes this tool exists to preserve — and it ran during the
 * PLAN, which the header of this file promises "changes nothing at all without --yes".
 *
 * Driven end to end on the exact case the preamble is written about, an operator who did
 * `cp backup.db live.db` and left the crash-time -wal beside it: the plan replayed 4 MB of an
 * unrelated database's log over a file that was byte-identical to a good 500-contact backup,
 * grew it from 16 KB to 900 KB, left `SELECT count(*) FROM contacts` answering "database disk
 * image is malformed", deleted the 4 MB log outright — and then printed "Nothing has been
 * changed." Both copies of the shop destroyed by the look-first step INSTALL.md tells you to
 * run first, with no safety copy, because a plan does not make one.
 *
 * The second defect is the quieter one. Even under --yes the probe ran before the safety copy,
 * so the -wal it preserved had already been checkpointed away: measured at exactly 0 bytes,
 * under a tool that prints "including any -wal, so this is undoable". It was not.
 *
 * Copies, not renames — a copy cannot hurt a database that is still live, and at this point we
 * have not yet established that nothing is using it.
 */
const preserved = new Set()
for (const p of pairs) {
  const rel = p.to.slice(DATA_ROOT.length + 1) || basename(p.to)
  mkdirSync(join(SAFETY, dirname(rel)), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const from = p.to + suffix
    if (!existsSync(from)) continue
    if (suffix && flag('--keep-wal')) continue
    copyFileSync(from, join(SAFETY, rel + suffix))
    preserved.add(from)
  }
}

/*
 * Only NOW is it safe to ask the question, because the answer costs a read-write open.
 * --force still overrides, and the safety copies above are already on disk either way.
 */
const busy = pairs.filter((p) => existsSync(p.to) && looksOpen(p.to)).length
if (busy && !FORCE) {
  die(`${busy} database(s) are still open — stop the app first.`,
    'sudo systemctl stop printshopcrm      (Docker:  docker compose stop app)\n'
    + '    Restoring under a running service corrupts the file and the service writes its own stale\n'
    + `    pages back over yours afterwards. --force overrides this; it is almost never right.\n`
    + `    Nothing was restored. A copy of what is on disk now is in ${SAFETY}.`)
}

for (const p of pairs) {
  const rel = p.to.slice(DATA_ROOT.length + 1) || basename(p.to)
  const keepDir = join(SAFETY, dirname(rel))
  mkdirSync(keepDir, { recursive: true })
  mkdirSync(dirname(p.to), { recursive: true })

  // Preserve the identity of the file we are replacing. A `sudo node bin/restore.mjs` otherwise
  // leaves root-owned databases behind and the service — which runs as an unprivileged user, see
  // deploy/printshopcrm.service — comes back up with "attempt to write a readonly database" on
  // every save. That is INSTALL.md's "Permission denied writing the database", caused by the fix.
  //
  // The gap this closes: the guard was `if (existsSync(p.to))`, so it only fired for a file being
  // REPLACED. Restoring a database that is MISSING — which is the exact case lib/tenants.mjs sends
  // an owner here for ("its database file is missing … Restore it from a snapshot with: npm run
  // restore") — took the identity of whoever ran the command. Measured: a 0640 tenant database,
  // deleted and restored, came back 0644, and under `sudo` it comes back owned by root, which is
  // "attempt to write a readonly database" on every save with no screen able to fix it.
  //
  // So when there is nothing to copy the identity FROM, take it from a sibling that is already
  // right: control.db, the default handle, or failing those the data root itself. One extra stat.
  let own = null
  if (existsSync(p.to)) {
    const st = statSync(p.to)
    own = { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 }
    // The safety copy is a plain byte copy, ON PURPOSE: the live file may be the corrupt one, and
    // a VACUUM INTO of a corrupt database fails, which would leave us with no copy at all. It was
    // taken in the preserve phase above, before the still-open probe could rewrite it.
    undo.push({ back: join(SAFETY, rel), to: p.to })
  }

  // The -wal and the -shm go with it. Their bytes were copied into the safety copy in the preserve
  // phase — never deleted without a copy, because the -wal may be the only place the last few
  // minutes of the shop's work exists, and a restore should never be the thing that destroys it.
  // What is left here is clearing them out of the way: left in place they replay over the restore,
  // which is what silently empties a restored database.
  for (const suffix of ['-wal', '-shm']) {
    const side = p.to + suffix
    if (!existsSync(side)) continue
    if (flag('--keep-wal')) { say(`    ! keeping ${basename(side)} in place because --keep-wal was given`); continue }
    if (preserved.has(side)) rmSync(side, { force: true })
    else renameSync(side, join(SAFETY, rel + suffix))
  }

  if (!own) {
    // Nothing was there to inherit from. Adopt the identity of a database that already works.
    const ref = [join(DATA_ROOT, 'control.db'), join(DATA_ROOT, 'printshop.db'), DATA_ROOT].find((f) => existsSync(f))
    if (ref) {
      const st = statSync(ref)
      // A directory's mode is not a file's — never hand 0755 to a database. Fall back to 0640,
      // which is what deploy/printshopcrm.service's ReadWritePaths expects.
      own = { uid: st.uid, gid: st.gid, mode: st.isDirectory() ? 0o640 : (st.mode & 0o7777) }
      // The directory that was just created for it needs the same owner, or the service cannot
      // write the -wal alongside the file it can now read.
      try { chownSync(dirname(p.to), own.uid, own.gid) } catch { /* not privileged */ }
    }
  }

  copyFileSync(p.from, p.to)
  if (own) { try { chownSync(p.to, own.uid, own.gid); chmodSync(p.to, own.mode) } catch { /* not privileged; leave as copied */ } }
  // Print what the service will actually see. An operator discovering this from a 500 an hour
  // later is the whole failure mode above.
  try {
    const st = statSync(p.to)
    say(`      owner ${st.uid}:${st.gid}  mode ${(st.mode & 0o7777).toString(8).padStart(4, '0')}`)
  } catch { /* nothing to report */ }

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

/* ------------------------------------------------------- the artwork */
let artNote = 'no artwork in this backup — the files on disk were left alone'
if (!flag('--skip-art') && artSource) {
  // MOVED aside, never deleted, and on the same filesystem so it is a rename rather than a copy
  // of somebody's whole art library. If the unpack fails it goes straight back.
  const kept = join(SAFETY, 'uploads-previous')
  let movedAside = false
  if (existsSync(ART_LIVE)) {
    mkdirSync(SAFETY, { recursive: true })
    renameSync(ART_LIVE, kept)
    movedAside = true
  }
  try {
    mkdirSync(ART_LIVE, { recursive: true })
    if (artSource.kind === 'archive') {
      // tar, because backup.sh wrote a tar and Node has no archive reader in the standard
      // library — and this tool takes no dependencies. Present on Linux, macOS and Windows 10+.
      execFileSync('tar', ['xzf', artSource.path, '-C', DATA_ROOT], { stdio: ['ignore', 'ignore', 'pipe'] })
    } else {
      const copyTree = (from, to) => {
        mkdirSync(to, { recursive: true })
        for (const e of readdirSync(from, { withFileTypes: true })) {
          if (e.isDirectory()) copyTree(join(from, e.name), join(to, e.name))
          else copyFileSync(join(from, e.name), join(to, e.name))
        }
      }
      copyTree(artSource.path, ART_LIVE)
    }
    const n = countArt(ART_LIVE)
    if (!n) throw new Error('the archive unpacked to no files')
    artNote = `${n} artwork file(s) restored to ${ART_LIVE}`
    if (movedAside) undo.push({ back: kept, to: ART_LIVE, dir: true })
    say(`  ✓ ${ART_LIVE}`)
    say(`      ${n} artwork file(s)`)
  } catch (e) {
    // Put the shop's own art back before saying anything else. A restore must never be the thing
    // that loses the files it was run to recover.
    try { if (movedAside) { renameSync(ART_LIVE, join(SAFETY, 'uploads-failed-unpack')); renameSync(kept, ART_LIVE) } } catch { /* nothing better to do */ }
    const why = String(e?.message || e).slice(0, 200)
    say('')
    say(`  ✗ THE ARTWORK DID NOT RESTORE: ${why}`)
    say(`      The databases above are restored. ${movedAside ? 'The art that was on disk has been put back.' : ''}`)
    say(`      Unpack it by hand:   tar xzf '${artSource.path}' -C '${DATA_ROOT}'`)
    artNote = `ARTWORK NOT RESTORED — ${why}`
  }
}

say('')
say(`  Restored ${restored} database(s).`)
say(`  Artwork: ${artNote}`)
if (!flag('--skip-art') && !artSource) {
  say('  → Every proof, mockup and shop logo the restored databases point at is a broken image.')
}
say(`  What was replaced is in ${SAFETY} — including any -wal, so this is undoable:`)
say('')
for (const u of undo.slice(0, 3)) say(`      ${u.dir ? `rm -rf '${u.to}' && mv '${u.back}' '${u.to}'` : `cp '${u.back}' '${u.to}'`}`)
if (undo.length > 3) say(`      … and ${undo.length - 3} more`)
say('')
say('  Start the app and check it:')
say('')
say('      sudo systemctl start printshopcrm')
say('      curl -fsS http://127.0.0.1:${PORT:-3333}/health')
say('')
say(`  When the shop looks right, delete ${SAFETY}. Not before.`)
say('')
