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

for (const f of doomed) rmSync(join(dir, f), { force: true })
console.log(`  removed ${doomed.length} file(s): ${doomed.join(', ')}`)
