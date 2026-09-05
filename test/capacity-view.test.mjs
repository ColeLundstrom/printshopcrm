import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../public/js/views/capacity.js', import.meta.url), 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const report = extra => ({ capacity: { minutes: 144, stations: 1, hours: 8, utilizationPct: 30 }, timeline: [], bookedThrough: null, backlogDays: 0,
  freeHoursThisWeek: 12, bookedHours: 0, atRiskCount: 0, jobs: [], unsized: [], modeled_count: 0, unresolved: [], unresolved_count: 0, scope_complete: true, can_manage: true, ...extra })
const answer = extra => ({ scope: 'screen_print', scope_complete: true, earliestFinish: '2026-09-11', feasible: true, slackDays: 1, hours: 2, workingDaysOut: 3, ...extra })

function fixture() {
  const nodes = new Map(), posts = [], puts = [], notices = [], timers = new Map()
  let timerId = 0
  class Node {
    constructor(id, parent = null) { this.id = id; this.parent = parent; this.children = []; this.connected = true; this.html = ''; this.value = ''; this.disabled = false; this.textContent = ''; this.listeners = new Map(); this.hidden = false }
    get isConnected() { return this.connected && (!this.parent || this.parent.isConnected) }
    get innerHTML() { return this.html }
    set innerHTML(html) {
      const detach = n => { n.connected = false; if (nodes.get(n.id) === n) nodes.delete(n.id); n.children.forEach(detach) }
      this.children.forEach(detach); this.children = []; this.html = html
      for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
        const n = new Node(match[1], this); n.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || ''; n.hidden = /\shidden[\s>]/.test(match[0]); this.children.push(n); nodes.set(n.id, n)
      }
    }
    closest() { return this }
    setAttribute(name, value) { this[name] = value }
    reportValidity() { return true }
    focus() { this.focused = true }
  }
  const view = new Node('view'); nodes.set('view', view)
  const node = id => nodes.get(id)
  const api = {
    get: async path => api.getOverride ? api.getOverride(path) : report(),
    post: async (path, body) => { posts.push({ path, body }); return api.postOverride ? api.postOverride(path, body) : answer() },
    put: async (path, body) => { puts.push({ path, body }); return api.putOverride ? api.putOverride(path, body) : report() },
  }
  const ctx = vm.createContext({ api, $: selector => node(selector.slice(1)), $$: () => [], setPage() {}, empty: () => 'No active jobs', esc: value => String(value ?? '').replaceAll('<', '&lt;'),
    on: (root, _selector, callback, type) => root.listeners.set(type, callback), onOnce() {}, go() {}, fmtDate: value => String(value), today: () => '2026-09-04', localDay: date => date.toISOString().slice(0, 10), shopLocale: () => 'en-US',
    announce: value => notices.push(value), toast: value => notices.push(value), setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id), console })
  vm.runInContext(source.replace(/^import[^\n]+\n/, '').replace('export async function capacityView', 'async function capacityView') + '\nglobalThis.renderView = capacityView', ctx)
  return { api, node, posts, puts, notices, view, render: () => ctx.renderView(),
    input(id, value) { const n = node(id); n.value = value; n.listeners.get('input')?.() },
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()) },
    leave() { view.innerHTML = '<p>Other view</p>' },
  }
}

test('partial scope and job reasons stay visible without a shipping or on-time promise', async () => {
  const f = fixture(); f.api.getOverride = () => report({ scope_complete: false, unresolved_count: 1,
    unresolved: [{ id: 2, title: 'Embroidery', reason: 'Outside the screenprinting model.' }],
    jobs: [{ id: 2, title: 'Embroidery', scope_state: 'unresolved', reason: 'Outside the screenprinting model.', minutes: null }] })
  f.api.postOverride = () => answer({ earliestFinish: null, feasible: null, reason: 'Review embroidery manually.' })
  await f.render(); await tick()
  assert.match(f.view.innerHTML, /The load below is partial/); assert.match(f.view.innerHTML, /Outside the screenprinting model/)
  assert.match(f.node('promise-out').innerHTML, /Review embroidery manually/)
  assert.doesNotMatch(f.view.innerHTML, /Realistically ships|schedule is realistic|room to take on new work|pill green">on time/)
  assert.equal(f.posts[0].body.decoration, 'Screen Print')
})

test('date checker displays print-only language and guards incomplete or horizon responses', async () => {
  const f = fixture(); await f.render(); await tick()
  assert.match(f.node('promise-out').innerHTML, /Print model fits/); assert.match(f.node('promise-out').innerHTML, /QC and delivery/)
  assert.doesNotMatch(f.node('promise-out').innerHTML, /ships by|Earliest ship/)
  f.api.postOverride = () => answer({ scope_complete: false }); f.input('pq', '200'); f.flush(); await tick()
  assert.match(f.node('promise-out').innerHTML, /coverage is incomplete/); assert.doesNotMatch(f.node('promise-out').innerHTML, /Print model fits/)
  f.api.postOverride = () => answer({ earliestFinish: null, feasible: false, beyondHorizon: true, reason: 'Split it into smaller runs.' })
  f.input('pq', '300'); f.flush(); await tick()
  assert.match(f.node('promise-out').innerHTML, /Not schedulable/); assert.match(f.notices.at(-1), /Split it into smaller runs/)
})

test('older requests cannot overwrite changed inputs, including the debounce gap', async () => {
  const f = fixture(), first = deferred(); f.api.postOverride = () => first.promise
  await f.render(); f.input('pq', '240'); first.resolve(answer({ earliestFinish: '1999-01-01' })); await tick()
  assert.match(f.node('promise-out').innerHTML, /Waiting for your changes/); assert.doesNotMatch(f.node('promise-out').innerHTML, /1999/)
  const second = deferred(); f.api.postOverride = () => second.promise; f.flush(); f.input('pq', '0'); f.flush()
  second.resolve(answer({ earliestFinish: '1999-02-01' })); await tick()
  assert.match(f.node('promise-out').innerHTML, /Enter a piece count/); assert.equal(f.posts.length, 2)
})

test('late reads, date checks and save failures cannot repaint another view or newer visit', async () => {
  const f = fixture(), read = deferred(); f.api.getOverride = () => read.promise
  const old = f.render(); f.leave(); read.resolve(report()); await old; assert.equal(f.view.innerHTML, '<p>Other view</p>')
  const newer = deferred(); f.api.getOverride = () => newer.promise; const first = f.render()
  f.api.getOverride = () => report({ can_manage: false }); await f.render(); newer.resolve(report()); await first
  assert.equal(f.node('model-save'), undefined, 'old privileged view does not overwrite current response')
  const date = deferred(); f.api.postOverride = () => date.promise; await f.render(); f.leave(); date.reject(new Error('late date error')); await tick()
  assert.equal(f.view.innerHTML, '<p>Other view</p>')
  f.api.getOverride = () => report(); f.api.postOverride = () => answer(); await f.render()
  const save = deferred(); f.api.putOverride = () => save.promise; const saving = f.node('model-save').onclick(); f.leave(); save.reject(new Error('late save error')); await saving
  assert.equal(f.view.innerHTML, '<p>Other view</p>'); assert(!f.notices.includes('late save error'))
})

test('settings save is singular, retains failed form values, and preserves the check inputs on success', async () => {
  const f = fixture(); await f.render(); await tick()
  f.input('pq', '432'); f.node('ms').value = '4'
  const wait = deferred(); f.api.putOverride = () => wait.promise
  const button = f.node('model-save'), first = button.onclick(); await button.onclick()
  assert.equal(f.puts.length, 1); assert.equal(button.disabled, true); assert.equal(f.node('ms').disabled, true)
  wait.reject(new Error('Save unavailable. Try again.')); await first
  assert.equal(f.node('ms').value, '4'); assert.equal(button.disabled, false); assert.equal(f.node('ms').disabled, false)
  assert.match(f.node('model-error').textContent, /Save unavailable/)
  f.api.putOverride = () => report({ capacity: { minutes: 576, stations: 4, hours: 8, utilizationPct: 30 } })
  await button.onclick(); await tick()
  assert.equal(f.node('pq').value, '432'); assert.equal(f.node('ms').value, '4'); assert.equal(f.node('model-toggle').focused, true)
})

test('staff model is read-only and failed initial load has a real retry', async () => {
  const f = fixture(); f.api.getOverride = () => report({ can_manage: false }); await f.render()
  assert.equal(f.node('model-save'), undefined); assert.match(f.view.innerHTML, /An owner or manager can adjust/)
  f.api.getOverride = () => { throw new Error('Network interrupted') }; await f.render()
  assert.match(f.node('capacity-loading').innerHTML, /Network interrupted/)
  f.api.getOverride = () => report(); await f.node('capacity-retry').onclick()
  assert(f.node('model-save'))
})
