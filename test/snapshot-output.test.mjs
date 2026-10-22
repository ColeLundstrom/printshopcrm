import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

test('snapshot refuses an output directory containing its live data root', t => {
  const parent = mkdtempSync(join(tmpdir(), 'psc-snapshot-parent-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = join(parent, 'data')
  mkdirSync(root)
  const live = join(root, 'printshop.db')
  const db = new DatabaseSync(live)
  db.exec('CREATE TABLE saved (id INTEGER PRIMARY KEY)')
  db.close()

  const result = spawnSync(process.execPath, ['bin/snapshot.mjs', root, parent], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /snapshot directory.*contain.*data root/i)
  assert.equal(existsSync(live), true, 'a typo in the destination must not delete the source database')
})
