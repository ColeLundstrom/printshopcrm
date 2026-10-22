import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { snapshotCollision } from '../lib/snapshot-name.mjs'

test('snapshot collision preflight uses the same name as the output on Windows and POSIX', () => {
  for (const tenantPath of ['tenants/acme/printshop.db', 'tenants\\acme\\printshop.db']) {
    const existing = 'tenants__acme__printshop.db'
    assert.deepEqual(snapshotCollision([tenantPath, existing]), {
      name: existing, first: tenantPath, second: existing,
    })
  }
  assert.equal(snapshotCollision(['printshop.db', 'tenants\\acme\\printshop.db']), null)
})

test('a colliding database leaves the previous verified snapshot untouched', t => {
  const root = mkdtempSync(join(tmpdir(), 'psc-snapshot-collision-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'tenants', 'acme'), { recursive: true })
  const output = join(root, '_snapshot')
  mkdirSync(output)
  writeFileSync(join(output, 'keep.txt'), 'previous verified snapshot')
  for (const name of ['tenants/acme/printshop.db', 'tenants__acme__printshop.db']) {
    const db = new DatabaseSync(join(root, name))
    db.exec('CREATE TABLE shop (id INTEGER)')
    db.close()
  }
  const result = spawnSync(process.execPath, ['bin/snapshot.mjs', root, output], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /two databases would be snapshotted to the same file/)
  assert.equal(readFileSync(join(output, 'keep.txt'), 'utf8'), 'previous verified snapshot')
})
