import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// core.js reads the DOM at import time; the pure helpers under test never touch it.
globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({}) }
globalThis.window ??= { addEventListener() {} }

test('the task list says what a shop can do, and only what this edition and role can finish', async () => {
  const { tasksFor, taskTiles } = await import('../public/js/shared/tasks.js')
  const keys = (list) => list.map((t) => t.key)
  assert.deepEqual(keys(tasksFor({}, 'pro')).slice(0, 3), ['estimate', 'mockup', 'followups'], 'the three named jobs lead')
  assert.ok(!keys(tasksFor({}, 'lite')).includes('mockup'), 'lite has no jobs to put a mockup on')
  assert.doesNotMatch(taskTiles({}, 'lite'), /href="#\/board"/, 'lite never links to the job board')
  assert.ok(!keys(tasksFor({ can_manage: false }, 'pro')).includes('followups'), 'staff cannot author automations, so are not offered them')
  for (const href of tasksFor({}, 'pro').map((t) => t.href)) assert.match(href, /^#\//)
})

test('every guided screen is routed, and Home and the New button both use the task list', () => {
  const app = read('public/js/app.js')
  for (const [re, view] of [['do\\/estimate', 'doEstimateView'], ['do\\/mockup', 'doMockupView'], ['auto-follow-ups', 'autoFollowupsView']]) {
    assert.ok(app.includes(re) && app.includes(view), `${view} is routed`)
  }
  assert.match(app, /taskTiles\(/, 'the New menu draws the same tiles as Home')
  assert.match(read('public/index.html'), /id="new-trigger"/, 'the top bar carries a New button on every screen')
  assert.match(read('public/js/views/today.js'), /What do you want to do\?/)
  assert.match(read('public/index.html'), /\/css\/guided\.css\?v=__ASSET_V__/, 'the stylesheet is version-stamped like the rest')
})

test('the sidebar leads with the everyday screens and folds the rest under All tools', () => {
  const app = read('public/js/app.js')
  const everyday = app.slice(app.indexOf('const NAV = ['), app.indexOf('const TOOLS = ['))
  const names = [...everyday.matchAll(/name: '([^']+)'/g)].map((m) => m[1]).filter((n) => n !== 'Control Room')
  assert.ok(names.length <= 8, `the always-visible list stays short (${names.join(', ')})`)
  assert.ok(names.includes('Estimates'), 'Estimates keeps its exact name for the workflow tests')
  assert.match(app, /'All tools'/)
})

test('every way to start an estimate lands on the guided screen, with the full editor one click away', () => {
  assert.match(read('public/js/views/estimates.js'), /go\('\/do\/estimate'\)/)
  assert.match(read('public/js/views/contacts.js'), /go\(`\/do\/estimate\?contact=\$\{id\}`\)/)
  assert.match(read('public/js/keys.js'), /'\*': '\/do\/estimate'/)
  assert.match(read('public/js/views/do-estimate.js'), /href="#\/estimates\/new">Use the full editor/)
})

test('a follow-up card edits only its own email step and previews what the customer reads', async () => {
  const { ruleFor, withEmail, previewText, RECIPES } = await import('../public/js/views/auto-followups.js')
  const quote = RECIPES.find((r) => r.trigger === 'estimate.stale')
  const rules = [
    { id: 1, name: 'Flag big quotes', trigger: 'estimate.stale', actions: [{ key: 'notify.staff', config: {} }] },
    { id: 2, name: 'My own chase', trigger: 'estimate.stale', actions: [{ key: 'email.customer', config: { subject: 'a', body: 'b' } }] },
    { id: 3, name: quote.starter, trigger: 'estimate.stale', actions: [{ key: 'email.customer', config: { subject: 'x', body: 'y' } }] },
  ]
  assert.equal(ruleFor(quote, rules).id, 3, 'the starter rule by name wins')
  assert.equal(ruleFor(quote, rules.slice(0, 2)).id, 2, 'else the first rule on the trigger that emails the customer')
  assert.equal(ruleFor(quote, rules.slice(0, 1)), null, 'a staff-only rule is not a customer follow-up')

  const steps = [{ key: 'email.customer', config: { subject: 'old', body: 'old', cc: 'keep' } }, { key: 'wait', config: { days: 2 } }, { key: 'email.customer', config: { subject: 'second' } }]
  const out = withEmail(steps, 'New subject', 'New body')
  assert.deepEqual(out[0].config, { subject: 'New subject', body: 'New body', cc: 'keep' })
  assert.deepEqual(out.slice(1), steps.slice(1), 'later steps — including a second email — are left alone')

  assert.equal(previewText('Hi {{first_name}}, {{estimate_number}} from {{shop_name}} {{unknown}}', 'Rebel Ink'), 'Hi Dana, EST-1042 from Rebel Ink {{unknown}}')
})

test('quick-price prices plain choices with the shop engine, and starters come back with the rules', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-guided-')), dest = join(temp, 'demo'), server = await createHttpTestServer()
  let control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: ROOT, encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')); env.PSC_TICK_MS = '3600000'
    control = new DatabaseSync(join(dest, 'data/control.db')); control.exec('PRAGMA busy_timeout=5000')
    const owner = control.prepare('SELECT * FROM members LIMIT 1').get()
    control.prepare("INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,datetime('now','+1 hour'))").run('guided-owner', owner.tenant_id, owner.id)
    const tenantDb = new DatabaseSync(join(dest, 'data/tenants', readdirSync(join(dest, 'data/tenants'))[0], 'printshop.db'))
    const before = tenantDb.prepare('SELECT COUNT(*) AS c FROM estimates').get().c
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const post = async (body, cookie = 'psc_session=guided-owner') => {
      const r = await fetch(server.base + '/api/quick-price', { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
      return { status: r.status, body: await r.json() }
    }
    assert.equal((await post({ order: { total_pieces: 10 } }, null)).status, 401)
    assert.equal((await post({ order: 'nope' })).status, 400)
    assert.equal((await post({ order: { garment: 'Tee' } })).body.priced, null, 'no quantity, no invented price')

    const one = await post({ order: { garment: 'Gildan 5000', sizes: { S: 10, M: 20, BOGUS: 99 }, decoration: 'Screen Print', locations: [{ name: 'Front', colors: 2 }] } })
    assert.equal(one.status, 200)
    assert.equal(one.body.priced.pieces, 30, 'unknown sizes are dropped, not priced')
    assert.ok(one.body.priced.per_piece > 0 && one.body.priced.totals.total > 0)
    assert.ok(one.body.priced.items.some((i) => /Screen setup/.test(i.description)), 'screen print carries its setup line')
    const two = await post({ order: { garment: 'Gildan 5000', sizes: { S: 10, M: 20 }, decoration: 'Screen Print', locations: [{ name: 'Front', colors: 2 }, { name: 'Back', colors: 1 }] } })
    assert.ok(two.body.priced.totals.total > one.body.priced.totals.total, 'a second print location costs more')
    assert.equal(tenantDb.prepare('SELECT COUNT(*) AS c FROM estimates').get().c, before, 'pricing writes nothing')

    const autos = await (await fetch(server.base + '/api/automations', { headers: { cookie: 'psc_session=guided-owner' } })).json()
    assert.ok(Array.isArray(autos.starters) && autos.starters.some((s) => s.trigger === 'estimate.stale'), 'the starter templates ride along')
    tenantDb.close()
  } finally {
    control?.close()
    await server.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
