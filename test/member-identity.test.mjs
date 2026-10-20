import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

test('member ids never go backwards, and the upgrade keeps every existing id and row', () => {
  const root = mkdtempSync(join(tmpdir(), 'psc-member-identity-'))
  const env = { ...process.env, PSC_DB: join(root, 'printshop.db'), PSC_CONTROL_DB: join(root, 'control.db') }
  const run = (script) => {
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 30000 })
    assert.equal(r.status, 0, r.stderr + '\n' + r.stdout)
    return r.stdout.trim()
  }
  try {
    run(`
      import assert from 'node:assert/strict'; const t = await import('./lib/tenants.mjs');
      const shop = await t.createTenant({ shop_name: 'Member fixture', owner_email: 'owner@example.test', password: 'fixture-password-123' });
      const a = await t.addMember(shop.id, { name: 'A', email: 'a@example.test', password: 'fixture-pass-123', role: 'staff' });
      assert.equal(t.deleteMember(shop.id, a.id), true);
      const b = await t.addMember(shop.id, { name: 'B', email: 'b@example.test', password: 'fixture-pass-123', role: 'staff' });
      assert.ok(b.id > a.id, 'deleting the newest member must not hand its id to the next one');
    `)
    // A registry from before this release: no sequence table or trigger, the highest member gone,
    // and its id surviving only in session history.
    const db = new DatabaseSync(env.PSC_CONTROL_DB)
    db.exec('DROP TRIGGER member_identity_high_water; DROP TABLE member_identity_sequence')
    const rows = db.prepare('SELECT id,email,tenant_id,role FROM members ORDER BY id').all().map((r) => ({ ...r }))
    const tenant = rows[0].tenant_id
    db.prepare("INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES('old-session',?,40,'2999-01-01')").run(tenant)
    db.close()
    const out = run(`
      import assert from 'node:assert/strict'; const t = await import('./lib/tenants.mjs');
      const c = await t.addMember(${tenant}, { name: 'C', email: 'c@example.test', password: 'fixture-pass-123', role: 'staff' });
      console.log(c.id);
    `)
    assert.equal(Number(out), 41)
    const after = new DatabaseSync(env.PSC_CONTROL_DB)
    try {
      assert.deepEqual(after.prepare('SELECT id,email,tenant_id,role FROM members WHERE id<41 ORDER BY id').all().map((r) => ({ ...r })), rows)
    } finally { after.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
