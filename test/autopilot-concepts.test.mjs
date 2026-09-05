import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Exercise the actual view with a tiny DOM/canvas boundary. No model, email, proof upload,
// provider account or real customer is involved.
function harness() {
  const elements = new Map(), posts = [], labels = [], revoked = []
  let canvases = 0, failImage = false
  const $ = key => {
    if (!elements.has(key)) elements.set(key, { innerHTML: '', value: '', textContent: '', style: {}, classList: { add() {}, remove() {} } })
    return elements.get(key)
  }
  const result = { mode: 'review', steps: [], order: { garment: 'Gildan 18500 hoodie', garment_color: 'navy' }, contact: { name: 'Robotics' }, job: { id: 9, job_number: 'JOB-9' }, estimate: { id: 3, estimate_number: 'EST-3', total: 800, status: 'draft' } }
  const api = {
    post: async (path, body) => { posts.push({ path, body }); if (path !== '/api/autopilot') throw Error('Unexpected write: ' + path); return result },
    req: async (...args) => { posts.push(args); throw Error('A concept must not enter the proof queue') },
  }
  const context = vm.createContext({
    api, $, $$: () => [], esc: v => String(v), money: v => '$' + v, setPage() {}, toast() {}, go() {}, on() {}, store: { get() { return null }, set() {} },
    URL: { createObjectURL: () => 'blob:reference', revokeObjectURL: u => revoked.push(u) },
    setTimeout: fn => { fn(); return 0 },
    Image: class { width = 200; height = 100; set src(v) { failImage ? this.onerror() : this.onload() } },
    Path2D: class {},
    document: { createElement(type) {
      assert.equal(type, 'canvas'); canvases++
      const ctx = new Proxy({ createLinearGradient: () => ({ addColorStop() {} }), fillText: text => labels.push(text) }, { get: (obj, key) => key in obj ? obj[key] : () => {} })
      return { getContext: () => ctx, toDataURL: () => 'data:image/png;base64,local-concept' }
    } },
  })
  let source = readFileSync(new URL('../public/js/views/autopilot.js', import.meta.url), 'utf8')
  source = source.replace(/^import[^\n]+\n/, '').replace('export async function autopilotView', 'async function autopilotView')
  vm.runInContext(source + '\nglobalThis.subject = { autopilotView, run };', context)
  return { $, posts, labels, revoked, subject: context.subject, get canvases() { return canvases }, set failImage(v) { failImage = v } }
}

test('Autopilot leaves absent artwork absent; a hoodie order gets no invented proof', async () => {
  const h = harness(); await h.subject.autopilotView()
  h.$('#ap-text').value = '48 navy hoodies for the robotics team'
  await h.subject.run()
  assert.deepEqual(h.posts.map(p => p.path), ['/api/autopilot'])
  assert.equal(h.canvases, 0)
  assert.match(h.$('#ap-stage').innerHTML, /Artwork still needed/)
  assert.doesNotMatch(h.$('#ap-stage').innerHTML, /<img/)
})

test('Supplied artwork makes a labelled local concept, never a proof; next customer starts empty', async () => {
  const h = harness(); await h.subject.autopilotView()
  h.$('#ap-text').value = '48 navy hoodies for the robotics team'
  h.$('#ap-file').onchange({ target: { files: [{ name: 'logo.png' }] } })
  await h.subject.run()
  assert.equal(h.canvases, 1)
  assert.match(h.labels.join(' '), /CONCEPT ONLY.*generic garment/)
  assert.match(h.$('#ap-stage').innerHTML, /not attached as a proof/)
  assert.deepEqual(h.posts.map(p => p.path), ['/api/autopilot'])
  await h.subject.autopilotView()
  assert.deepEqual(h.revoked, ['blob:reference'])
  h.$('#ap-text').value = 'Next customer with no artwork'
  await h.subject.run()
  assert.equal(h.canvases, 1)
  assert.match(h.$('#ap-stage').innerHTML, /Artwork still needed/)
})

test('An unreadable reference can retry the preview without creating another order', async () => {
  const h = harness(); await h.subject.autopilotView()
  h.$('#ap-text').value = '48 navy hoodies for the robotics team'
  h.$('#ap-file').onchange({ target: { files: [{ name: 'bad.eps' }] } })
  h.failImage = true
  await h.subject.run()
  assert.match(h.$('#ap-stage').innerHTML, /PNG or JPG/)
  h.failImage = false
  await h.$('#ap-run').onclick()
  assert.equal(h.posts.length, 1)
  assert.match(h.$('#ap-stage').innerHTML, /not attached as a proof/)
})


test('An unreadable reference can be removed and the existing order resumed without artwork', async () => {
  const h = harness(); await h.subject.autopilotView()
  h.$('#ap-text').value = '48 navy hoodies for the robotics team'
  h.$('#ap-file').onchange({ target: { files: [{ name: 'bad.eps' }] } })
  h.failImage = true
  await h.subject.run()
  h.$('#ap-clear').onclick()
  await h.$('#ap-run').onclick()
  assert.equal(h.posts.length, 1)
  assert.equal(h.canvases, 0)
  assert.match(h.$('#ap-stage').innerHTML, /Artwork still needed/)
})
