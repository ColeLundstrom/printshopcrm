import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// The wallboard snapshot runs against a seeded demo db in a child process, so this file never
// touches the developer's own database.
test('Shop TV snapshot: stages, lateness, and money only when allowed', { timeout: 60000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-tv-'))
  try {
    const env = { ...process.env, PSC_DB: join(dir, 'x.db') }
    const root = new URL('..', import.meta.url)
    const seeded = spawnSync(process.execPath, ['--no-warnings', 'seed.mjs'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(seeded.status, 0, seeded.stderr)
    const probe = `
      import { tvSnapshot } from './lib/tv.mjs'
      import { run, get, todayIso } from './lib/db.mjs'
      const t = todayIso()
      const late = new Date(Date.parse(t + 'T12:00:00Z') - 2 * 864e5).toISOString().slice(0, 10)
      run("UPDATE jobs SET due_date=? WHERE stage='shipping'", late)
      const a = tvSnapshot({ includeMoney: false }), b = tvSnapshot({ includeMoney: true })
      console.log(JSON.stringify({ a, b }))`
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', probe], { cwd: root, env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const { a, b } = JSON.parse(r.stdout)
    assert.deepEqual(a.columns.map((c) => c.key), ['new', 'art_approval', 'prepress', 'production', 'qc', 'shipping'], 'Complete is a count, not a lane')
    const shipping = a.columns.find((c) => c.key === 'shipping')
    assert.ok(shipping.late >= 1)
    assert.ok(a.stats.overdue >= shipping.late, 'a late box on the dock counts as late on the wall')
    assert.equal(a.stats.pieces_on_floor, a.columns.reduce((t, c) => t + c.pieces, 0))
    assert.equal(a.money, null, 'staff walls never carry revenue')
    assert.ok(a.recent.every((x) => !['payment', 'invoice', 'estimate'].includes(x.type)), 'money-bearing activity rides with the money permission')
    assert.equal(b.money.daily.length, 14)
    assert.ok(b.money.revenue_mtd >= 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
