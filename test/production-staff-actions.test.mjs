import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import vm from 'node:vm'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

// Run the actual view against an actual HTTP response. Only the DOM/event boundary is stubbed;
// the template is not copied into the test and this does not need a browser or provider account.
async function taskPage(data) {
  const elements = new Map()
  const $ = key => {
    if (!elements.has(key)) elements.set(key, { innerHTML: '', style: {}, classList: { contains: () => false } })
    return elements.get(key)
  }
  const context = vm.createContext({
    api: { get: async path => { assert.equal(path, '/api/production/jobs/' + data.job.id); return data } },
    $, $$: () => [], esc: v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    setPage() {}, fmtDate: v => v, window: { addEventListener() {} },
    location: { hash: '#/production/jobs/' + data.job.id }, document: { body: { classList: { contains: () => false } } },
  })
  const source = readFileSync(new URL('../public/js/views/production.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/m, '').replaceAll('export async function ', 'async function ')
  vm.runInContext(source + '\nglobalThis.subject = productionJobView;', context)
  await context.subject(data.job.id)
  return $('#view').innerHTML
}

test('staff task page matches live assignment and gates; managers and unassigned work remain usable', { timeout: 120000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'psc-staff-actions-')), dest = join(tmp, 'demo')
  const server = await createHttpTestServer()
  let control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000,
    })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    control = new DatabaseSync(join(dest, 'data/control.db'))
    const owner = control.prepare('SELECT id,tenant_id,password_hash FROM members LIMIT 1').get()
    const actors = {}
    for (const [name, role] of [['Alex fixture', 'staff'], ['Sam fixture', 'staff'], ['Manager fixture', 'manager']]) {
      const id = Number(control.prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)')
        .run(owner.tenant_id, name, name.split(' ')[0].toLowerCase() + '@example.test', owner.password_hash, role, 'active').lastInsertRowid)
      // Isolated authentication fixture. No invitation, shared production password, or provider call.
      const token = 'fixture-staff-action-' + id
      control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)')
        .run(token, owner.tenant_id, id, new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19))
      actors[name.split(' ')[0]] = { id, cookie: 'psc_session=' + token }
    }
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const ownerCookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const req = (path, { cookie = ownerCookie, method = 'GET', body } = {}) => fetch(server.base + path, {
      method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    })
    const json = async (path, opts) => { const r = await req(path, opts); assert.equal(r.status, 200, await r.clone().text()); return r.json() }
    const job = await json('/api/jobs', { method: 'POST', body: { contact_id: 1, title: 'Staff assignment fixture', decoration: 'Custom', sizes: { M: 1 }, quantities: '1 M' } })
    const template = await json('/api/production/templates', { method: 'POST', body: { name: 'Staff permission fixture', steps: [
      { title: 'Count the sample garment', department: 'Receiving', stage: 'new', gate: 'receiving', assigned_id: actors.Alex.id },
      { title: 'Second employee review', department: 'QC', stage: 'new', gate: '', assigned_id: actors.Sam.id },
      { title: 'Unassigned final review', department: 'QC', stage: 'new', gate: '', assigned_id: null },
    ] } })
    const path = '/api/production/jobs/' + job.id
    await json(path + '/workflow', { method: 'POST', body: { revision: 0, template_ids: [template.id] } })
    const details = actor => json(path, { cookie: actors[actor].cookie })
    const complete = (actor, d, task = d.tasks.find(t => t.status === 'pending')) => req(path + '/tasks/' + task.id + '/action', {
      method: 'POST', cookie: actors[actor].cookie, body: { revision: d.revision, action: 'complete' },
    })
    let d = await details('Alex')
    assert.equal(d.manager, false)
    assert.equal(d.tasks[0].can_complete, false)
    assert.match(d.tasks[0].completion_blocked, /Record the received garment counts first/)
    assert.equal((await complete('Alex', d)).status, 409)
    assert.doesNotMatch(await taskPage(d), /data-task-action="complete"/)
    assert.match(await taskPage(d), /Record the received garment counts first/)
    const managerHeld = await details('Manager')
    assert.equal(managerHeld.manager, true)
    assert.equal(managerHeld.tasks[0].can_complete, false)
    await json(path + '/counts', { method: 'POST', body: { revision: d.revision, counts: { M: 1 } } })

    d = await details('Alex')
    assert.equal(d.tasks[0].can_complete, true)
    assert.equal(d.tasks[0].completion_blocked, '')
    assert.equal(d.tasks[1].can_complete, false)
    assert.match(await taskPage(d), /data-task-action="complete"/)
    const other = await details('Sam')
    assert.equal(other.tasks[0].blocked, '')
    assert.equal(other.tasks[0].can_complete, false)
    assert.match(other.tasks[0].completion_blocked, /Assigned to another employee/)
    assert.match(await taskPage(other), /That employee or a manager can complete this task/)
    assert.doesNotMatch(await taskPage(other), /data-task-action="complete"/)
    assert.equal((await complete('Sam', other)).status, 403)
    assert.deepEqual(await details('Sam'), other, 'A refused click cannot change the task or revision')
    const managerReady = await details('Manager')
    assert.equal(managerReady.tasks[0].can_complete, true)
    assert.match(await taskPage(managerReady), /data-task-action="complete"/)
    const oldResponse = structuredClone(d); delete oldResponse.tasks[0].can_complete
    assert.doesNotMatch(await taskPage(oldResponse), /data-task-action="complete"/, 'A missing capability does not imply permission')

    const own = await complete('Alex', d); assert.equal(own.status, 200)
    d = await own.json(); assert.equal(d.tasks[0].status, 'done'); assert.equal(d.tasks[0].can_complete, false)
    assert.equal(d.tasks[1].can_complete, false, 'Alex does not gain Sam’s next task')
    assert.doesNotMatch(await taskPage(d), /data-task-action="complete"/)
    const nextOwner = await details('Sam'); assert.equal(nextOwner.tasks[1].can_complete, true)
    assert.match(await taskPage(nextOwner), /data-task-action="complete"/)
    const nextManager = await details('Manager'); assert.equal(nextManager.tasks[1].can_complete, true)
    const managed = await complete('Manager', nextManager); assert.equal(managed.status, 200)
    assert.equal((await managed.json()).tasks[1].completed_by, 'Manager fixture')

    const unassigned = await details('Alex')
    assert.equal(unassigned.tasks[2].assigned_id, null); assert.equal(unassigned.tasks[2].can_complete, true)
    assert.match(await taskPage(unassigned), /Available to any team member/)
    assert.match(await taskPage(unassigned), /data-task-action="complete"/)
    const final = await complete('Alex', unassigned); assert.equal(final.status, 200)
    const finished = await final.json(); assert(finished.tasks.every(t => t.status === 'done' && t.can_complete === false))
    assert.doesNotMatch(await taskPage(finished), /data-task-action="complete"/)
    assert.match(await taskPage(finished), /All tasks resolved/)
  } finally {
    await server.close()
    control?.close()
    rmSync(tmp, { recursive: true, force: true })
  }
})
