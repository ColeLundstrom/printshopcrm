import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { onceClick } from '../public/js/core.js'

// Run the shipped quote editor's inline-customer handler against small DOM stand-ins.
const source = readFileSync(new URL('../public/js/views/estimates.js', import.meta.url), 'utf8')
const start = source.indexOf('  const addCustomerInline = () => {')
const end = source.indexOf("  $('#contact').addEventListener('change'", start)
assert(start > 0 && end > start)

test('creating a customer from a quote submits once while pending and selects the saved row', async () => {
  let resolveCreate, calls = 0, mounted, closed = 0
  const pending = new Promise(resolve => { resolveCreate = resolve })
  const nodes = new Map([
    ['#contact', { value: '', insertBefore(option) { this.option = option }, querySelector() { return {} } }],
    ['#nc-name', { value: 'First buyer', removeAttribute() {} }],
    ['#nc-company', { value: 'School' }],
    ['#nc-email', { value: 'buyer@example.test' }],
    ['#nc-save', { disabled: false, textContent: 'Create & use' }],
    ['#nc-err', { textContent: '', style: {} }],
  ])
  const contacts = [], est = {}, events = []
  const context = vm.createContext({
    $, modal: ({ onMount }) => { mounted = onMount }, onceClick,
    api: { post: async (path, body) => { calls++; assert.equal(path, '/api/contacts'); assert.equal(body.name, 'First buyer'); return pending } },
    contacts, est, document: { createElement: () => ({}) },
    syncTaxExempt: value => events.push(['tax', value]),
    loadCustomerAddresses: () => events.push(['addresses']),
    markEditorDirty: () => events.push(['dirty']),
    closeModal: () => { closed++ }, toast: () => {},
  })
  function $(selector) { return nodes.get(selector) }
  vm.runInContext(source.slice(start, end) + '\naddCustomerInline()', context)
  mounted({})
  const button = nodes.get('#nc-save')
  const first = button.onclick()
  const second = button.onclick()
  assert.equal(calls, 1)
  assert.equal(button.disabled, true)
  resolveCreate({ id: 42, name: 'First buyer', company: 'School' })
  await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(contacts.length, 1)
  assert.equal(nodes.get('#contact').value, '42')
  assert.equal(est.contact_id, 42)
  assert.equal(closed, 1)
  assert(events.some(([name]) => name === 'addresses'))
})
