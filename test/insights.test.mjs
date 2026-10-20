import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('shop pulse: twelve contiguous Monday weeks, honest nulls, payments land in their week', { timeout: 60000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-ins-'))
  try {
    const env = { ...process.env, PSC_DB: join(dir, 'x.db') }
    const root = new URL('..', import.meta.url)
    assert.equal(spawnSync(process.execPath, ['--no-warnings', 'seed.mjs'], { cwd: root, env }).status, 0)
    const probe = `
      import { shopInsights } from './lib/insights.mjs'
      import { get, getDb } from './lib/db.mjs'
      import { initSuppliers } from './lib/suppliers.mjs'
      initSuppliers(getDb())
      const i = shopInsights({ today: '2026-10-21' })
      const paid = get("SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE created_at >= ?", i.weeks[0].start).v
      console.log(JSON.stringify({ i, paid }))`
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', probe], { cwd: root, env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const { i, paid } = JSON.parse(r.stdout)
    assert.equal(i.weeks.length, 12)
    assert.equal(i.weeks[11].start, '2026-10-19', 'the last bar is the current Monday-based week')
    for (let k = 1; k < 12; k++) assert.equal(Date.parse(i.weeks[k].start) - Date.parse(i.weeks[k - 1].start), 7 * 864e5)
    for (const w of i.weeks) assert.equal(new Date(w.start + 'T12:00:00Z').getUTCDay(), 1)
    assert.ok(Math.abs(i.weeks.reduce((t, w) => t + w.collected, 0) - paid) < 0.01, 'every payment in range is in exactly one bar')
    assert.ok(i.win_rate_90d === null || (i.win_rate_90d >= 0 && i.win_rate_90d <= 100))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
