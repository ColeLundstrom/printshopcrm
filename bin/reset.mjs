#!/usr/bin/env node
/**
 * Delete the local development database so `npm run reset` can reseed it.
 *
 * Node rather than `rm -f` so this works on Windows too. Removes the database and its WAL/SHM
 * sidecars — deleting only the .db file leaves a -wal holding committed pages, and the "fresh"
 * database comes back with yesterday's rows in it.
 */
import { readdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const target = process.env.PSC_DB || join(process.cwd(), 'data', 'printshop.db')
const dir = dirname(target)
const stem = basename(target)

if (!existsSync(dir)) {
  console.log('  nothing to reset — no data directory yet')
  process.exit(0)
}

// The db plus any `printshop.db-wal` / `printshop.db-shm` beside it.
const doomed = readdirSync(dir).filter((f) => f === stem || f.startsWith(`${stem}-`))

if (!doomed.length) {
  console.log('  nothing to reset — no database found')
  process.exit(0)
}

console.log(`  resetting ${target}`)

/**
 * The same lock seed.mjs carries, on the half that runs FIRST.
 *
 * INSTALL.md says of both scripts: "they refuse to run against a shop that has named itself and
 * has records in it — so pointing PSC_DB at a live install and typing `npm run reset` by mistake
 * stops with a message instead of deleting the shop." Only seed.mjs had it. `npm run reset` is
 * `bin/reset.mjs && npm run seed`, so the unlink happened BEFORE the guard the docs describe ever
 * ran — the database was already gone, files and all, when seed printed its refusal. Measured: a
 * database with shop_name 'Acme Real Shop' and a customer row deleted, exit 0, nothing printed.
 *
 * Read-only, and every failure means "not a shop worth protecting": a missing table, a corrupt
 * file, a directory of unrelated .db-* leftovers. Deleting those is exactly what reset is for.
 */
const survey = () => {
  let db
  try {
    db = new DatabaseSync(target, { readOnly: true })
    const rows = (t) => { try { return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n || 0 } catch { return 0 } }
    const records = ['contacts', 'estimates', 'invoices', 'jobs', 'payments'].reduce((n, t) => n + rows(t), 0)
    let shop = ''
    try { shop = String(db.prepare("SELECT value FROM settings WHERE key = 'shop_name'").get()?.value || '').trim() } catch { /* no settings table */ }
    return { records, shop }
  } catch { return { records: 0, shop: '' } }
  finally { try { db?.close() } catch { /* already closed */ } }
}

const { records, shop } = survey()
// A shop that has named itself and has records is a real one. The demo shop is fair game — that
// is the whole point of the script — and so is a blank database.
/**
 * A blank shop_name does NOT mean "this is the demo".
 *
 * lib/db.mjs's own default for shop_name is '', and no screen in the product forces it — a shop
 * can take orders for a year without ever typing its own name into Settings. Treating that as the
 * demo meant a database with 13 real records and a blank name was deleted, `removed 1 file(s)`,
 * exit 0, and reseeded as Rebel Ink Press. INSTALL.md promises the opposite in as many words.
 *
 * Records are what make a shop real. The demo is identified by the exact name the demo writes,
 * and by nothing else. A genuinely blank database still seeds and resets freely, because it has
 * no records.
 */
if (records > 0 && shop !== 'Rebel Ink Press' && process.env.PSC_SEED_FORCE !== '1') {
  console.error(`\n  Refusing to reset: that database belongs to a real shop.\n`)
  console.error(`    database   ${target}`)
  console.error(`    shop       ${shop || '(unnamed — a shop that never filled in Settings is still a real shop)'}`)
  console.error(`    records    ${records} across contacts, estimates, invoices, jobs and payments\n`)
  console.error(`  Resetting DELETES the file and everything in it. There is no undo.`)
  console.error(`  If you want a demo database, point PSC_DB somewhere else:`)
  console.error(`    PSC_DB=./data/demo.db npm run reset\n`)
  console.error(`  If you really mean to wipe this one, back it up first and then:`)
  console.error(`    PSC_SEED_FORCE=1 npm run reset\n`)
  process.exit(1)
}

for (const f of doomed) rmSync(join(dir, f), { force: true })
console.log(`  removed ${doomed.length} file(s): ${doomed.join(', ')}`)
