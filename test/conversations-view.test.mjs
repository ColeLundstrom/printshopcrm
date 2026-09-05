import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/js/views/conversations.js', import.meta.url), 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))

// Execute the actual view with a small connected/detached DOM fixture and no network.
function fixture() {
  const nodes = new Map(), posts = [], notices = []
  class Node {
    constructor(id, parent = null) { this.id = id; this.parent = parent; this.connected = true; this.children = []; this.listeners = new Map(); this.value = ''; this.dataset = {}; this.disabled = false; this.html = ''; this.scrollHeight = 0 }
    get isConnected() { return this.connected && (!this.parent || this.parent.isConnected) }
    get innerHTML() { return this.html }
    set innerHTML(html) {
      const detach = n => { n.connected = false; if (nodes.get(n.id) === n) nodes.delete(n.id); n.children.forEach(detach) }
      this.children.forEach(detach); this.children = []; this.html = html
      for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
        const n = new Node(match[1], this); n.disabled = /\sdisabled(?:\s|>)/.test(match[0]); this.children.push(n); nodes.set(n.id, n)
      }
      const channel = nodes.get('ct-channel')
      if (this.id === 'convo-thread' && channel) {
        channel.buttons = ['email', 'sms'].map(ch => {
          const n = new Node('channel-' + ch, channel); n.dataset.ch = ch
          n.selected = html.includes(`data-ch="${ch}" class="on"`)
          n.classList = { toggle: (_, value) => { n.selected = value } }; n.setAttribute = () => {}
          return n
        })
      }
    }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn) }
    fire(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn(event) }
  }
  const view = new Node('view'); nodes.set('view', view)
  const node = id => nodes.get(id)
  const $ = (selector, root) => {
    if (selector === '#ct-channel .on') return node('ct-channel')?.buttons.find(n => n.selected)
    const n = node(selector.slice(1)); return !root || n?.parent === root ? n || null : null
  }
  const $$ = () => node('ct-channel')?.buttons || []
  const data = id => ({ contact: { id, name: `Customer ${id}`, email: `customer${id}@example.test` }, messages: [] })
  const api = {
    get: async path => api.getOverride?.(path) ?? (path === '/api/conversations' ? { threads: [1, 2].map(id => ({ id, name: `Customer ${id}` })) } : data(Number(path.split('/').at(-1)))),
    post: async (path, body) => { posts.push({ path, body }); return api.postOverride ? api.postOverride(path, body) : {} },
  }
  const ctx = vm.createContext({ api, $, $$, setPage() {}, empty: () => 'Empty', esc: value => String(value ?? '').replaceAll('<', '&lt;'), initials: () => 'C', relTime: () => 'Today', toast: (...args) => notices.push(args), announce() {},
    on: (root, selector, fn) => { root.delegate = fn }, onOnce: (root, selector, fn) => { root.delegate ||= fn }, go() {},
    location: { hash: '#/conversations/1' }, window: { __me: { single_tenant: false } }, console })
  vm.runInContext(source.replace(/^import[^\n]+\n/, '').replace('export async function conversationsView', 'async function conversationsView') + '\nglobalThis.renderView = conversationsView', ctx)
  return { node, api, data, posts, notices, view, ctx,
    render: id => { ctx.location.hash = '#/conversations/' + id; return ctx.renderView(id) },
    type: text => { node('ct-text').value = text; node('ct-text').fire('input') },
    channel: ch => node('ct-channel').delegate({}, node('ct-channel').buttons.find(n => n.dataset.ch === ch)),
    selected: () => node('ct-channel').buttons.find(n => n.selected).dataset.ch,
    leave: () => { ctx.location.hash = '#/board'; view.innerHTML = '<p>Different screen</p>' },
  }
}

test('draft text and channel stay with their customer across switches and realtime refreshes', async () => {
  const f = fixture(); await f.render(1); f.type('Private pricing for customer one'); f.channel('sms')
  await f.render(2)
  assert.equal(f.node('ct-text').value, ''); assert.equal(f.selected(), 'email')
  f.type('Reply only for customer two'); await f.node('ct-send').onclick()
  assert.equal(f.posts[0].path, '/api/conversations/2/reply')
  assert.equal(f.posts[0].body.body, 'Reply only for customer two')
  await f.render(1); assert.equal(f.node('ct-text').value, 'Private pricing for customer one'); assert.equal(f.selected(), 'sms')
  await f.render(1); assert.equal(f.node('ct-text').value, 'Private pricing for customer one'); assert.equal(f.selected(), 'sms')
})

test('typing during a refresh survives; superseded and detached reads cannot replace the current thread', async () => {
  const f = fixture(); await f.render(1)
  const old = deferred(); f.api.getOverride = path => path === '/api/conversations/1' ? old.promise : undefined
  const refresh = f.render(1); await tick(); f.type('Typed after GET began'); f.channel('sms')
  old.resolve(f.data(1)); await refresh
  assert.equal(f.node('ct-text').value, 'Typed after GET began'); assert.equal(f.selected(), 'sms')
  const late = deferred(); f.api.getOverride = path => path === '/api/conversations/1' ? late.promise : undefined
  const older = f.render(1); await tick(); await f.render(2); f.type('Two stays here')
  late.resolve(f.data(1)); await older
  assert.match(f.node('convo-thread').innerHTML, /Customer 2/); assert.equal(f.node('ct-text').value, 'Two stays here')
  const gone = deferred(); f.api.getOverride = path => path === '/api/conversations/2' ? gone.promise : undefined
  const pending = f.render(2); await tick(); f.leave(); gone.resolve(f.data(2)); await pending
  assert.equal(f.view.innerHTML, '<p>Different screen</p>')
})

test('overlapping conversation-list reads cannot select or paint a stale destination', async () => {
  const f = fixture(), first = deferred(); let calls = 0
  f.api.getOverride = path => path === '/api/conversations' && calls++ === 0 ? first.promise : undefined
  const older = f.render(1); await f.render(2); first.resolve({ threads: [{ id: 1, name: 'STALE LIST' }] }); await older
  assert.match(f.node('convo-thread').innerHTML, /Customer 2/); assert.doesNotMatch(f.node('convo-list').innerHTML, /STALE LIST/)
})

test('an in-flight send stays singular across repaint, switch and navigation; its completion never clears another draft', async () => {
  const f = fixture(); await f.render(1); f.type('Send one'); const waiting = deferred(); f.api.postOverride = () => waiting.promise
  const oldButton = f.node('ct-send'), first = oldButton.onclick(); await oldButton.onclick()
  await f.render(1); assert.equal(f.node('ct-send').disabled, true); await f.node('ct-send').onclick()
  f.leave(); await f.render(1); assert.equal(f.node('ct-send').disabled, true); await f.node('ct-send').onclick()
  await f.render(2); f.type('Do not erase customer two'); waiting.resolve({}); await first
  assert.equal(f.posts.length, 1); assert.equal(f.node('ct-text').value, 'Do not erase customer two')
  await oldButton.onclick(); assert.equal(f.posts.length, 1, 'detached handler is inert')
  await f.render(1); assert.equal(f.node('ct-text').value, ''); assert.equal(f.node('ct-send').disabled, false)
})

test('send success keeps newer work; failed sends retain the draft and expose an actionable error', async () => {
  const f = fixture(); await f.render(1); f.type('First reply'); let waiting = deferred(); f.api.postOverride = () => waiting.promise
  const send = f.node('ct-send').onclick(); f.type('New reply while sending'); waiting.resolve({}); await send
  assert.equal(f.node('ct-text').value, 'New reply while sending')
  waiting = deferred(); const failed = f.node('ct-send').onclick(); await f.render(2); waiting.reject(new Error('Reconnect email and try again')); await failed
  await f.render(1); assert.equal(f.node('ct-text').value, 'New reply while sending'); assert.equal(f.node('ct-send').disabled, false)
  assert.match(f.node('convo-thread').innerHTML, /Reconnect email and try again/)
})

test('delayed AI results belong to the original customer, cannot overwrite edits, and do not dispatch twice', async () => {
  const f = fixture(); await f.render(1); let waiting = deferred(); f.api.postOverride = () => waiting.promise
  const ai = f.node('ct-ai').onclick(); await f.render(1); assert.equal(f.node('ct-ai').disabled, true); await f.node('ct-ai').onclick()
  await f.render(2); f.type('Customer two manual response'); waiting.resolve({ text: 'Draft for customer one' }); await ai
  assert.equal(f.posts.length, 1); assert.equal(f.node('ct-text').value, 'Customer two manual response')
  await f.render(1); assert.equal(f.node('ct-text').value, 'Draft for customer one'); assert.equal(f.node('ct-ai').disabled, false)
  waiting = deferred(); const next = f.node('ct-ai').onclick(); f.type('Manual edit wins'); waiting.resolve({ text: 'Outdated generated text' }); await next
  assert.equal(f.node('ct-text').value, 'Manual edit wins')
})

test('a different signed-in identity starts with no prior drafts or pending state', async () => {
  const f = fixture(); await f.render(1); f.type('Private account draft'); f.leave(); f.ctx.window.__me = { single_tenant: false, member: { email: 'another@example.test' } }
  await f.render(1); assert.equal(f.node('ct-text').value, '')
})
