import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./browser/receivables-review-smoke.mjs', import.meta.url), 'utf8')
const helper = source.slice(source.indexOf('const deferred ='), source.indexOf('\nasync function exercise('))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

function fixture({ fetchError, fulfillError } = {}) {
  const base = 'http://127.0.0.1:4380', scenario = { networkErrors: [] }, events = []
  const fetched = deferred(), fulfilling = deferred(), finishFetch = deferred(), finishFulfill = deferred()
  let callback, handled = false, active = false, unroutes = 0, closeDone = false
  const response = { status: () => 200 }
  const route = {
    request: () => ({ method: () => 'GET', url: () => base + '/api/reports/ar-aging' }),
    async fetch(options) {
      assert.deepEqual({ ...options }, { maxRedirects: 0, timeout: 15000 })
      events.push('fetch'); fetched.resolve()
      await finishFetch.promise
      if (fetchError) throw Error(fetchError)
      return response
    },
    async fulfill(options) {
      assert.equal(options.response, response)
      events.push('fulfill-start'); fulfilling.resolve()
      await finishFulfill.promise
      if (handled) throw Error('route.fulfill: Route is already handled!')
      if (fulfillError) throw Error(fulfillError)
      handled = true; events.push('fulfilled')
    },
    async abort(reason) {
      assert.equal(reason, 'failed')
      if (handled) throw Error('route.abort: Route is already handled!')
      handled = true; events.push('aborted')
    },
  }
  const page = {
    async route(url, handler, options) {
      assert.equal(url, base + '/api/reports/ar-aging')
      assert.equal(options.times, 1)
      callback = handler
    },
    async unroute(url, handler) {
      assert.equal(url, base + '/api/reports/ar-aging'); assert.equal(handler, callback)
      unroutes++; events.push('unroute')
      // Playwright 1.64 advances an in-flight route to its next interceptor when the
      // current page interceptor is removed. The context isolation handler then owns it.
      if (active && !handled) { handled = true; events.push('context-fallback') }
    },
  }
  const context = vm.createContext({ assert, server: { base }, setTimeout, clearTimeout, secrets: [], redact: String })
  vm.runInContext(helper + '\nglobalThis.hold=holdNextReport;', context)
  return {
    scenario, events, fetched, fulfilling, finishFetch, finishFulfill,
    unroutes: () => unroutes, closeDone: () => closeDone,
    mount: () => context.hold(page, scenario),
    dispatch() { active = true; return callback(route).finally(() => { active = false }) },
    close(held) { return held.close().then(() => { closeDone = true }) },
  }
}

test('the delayed report completes fulfillment before removing its page interceptor', async () => {
  const f = fixture(), held = await f.mount(), work = f.dispatch()
  f.finishFetch.resolve(); await held.ready()
  const closing = f.close(held)
  await f.fulfilling.promise
  const removedBeforeFulfill = f.unroutes(), closedBeforeFulfill = f.closeDone()
  f.finishFulfill.resolve(); await work; await closing
  assert.equal(removedBeforeFulfill, 0, 'Unrouting a pending fulfill hands it to the context interceptor')
  assert.equal(closedBeforeFulfill, false)
  assert.deepEqual(f.events, ['fetch', 'fulfill-start', 'fulfilled', 'unroute'])
  assert.deepEqual(f.scenario.networkErrors, [])
})

test('closing during fetch drains the fetch and fulfillment, and repeated close is idempotent', async () => {
  const f = fixture(), held = await f.mount(), work = f.dispatch()
  await f.fetched.promise
  const first = f.close(held), second = f.close(held)
  await Promise.resolve()
  const removedDuringFetch = f.unroutes()
  f.finishFetch.resolve(); await f.fulfilling.promise
  const removedDuringFulfill = f.unroutes()
  f.finishFulfill.resolve(); await work; await Promise.all([first, second]); await held.close()
  assert.equal(removedDuringFetch, 0); assert.equal(removedDuringFulfill, 0)
  assert.equal(f.unroutes(), 1)
  assert.deepEqual(f.scenario.networkErrors, [])
})

test('closing an unused delay removes only its own handler once', async () => {
  const f = fixture(), held = await f.mount()
  await Promise.all([held.close(), held.close()]); await held.close()
  assert.equal(f.unroutes(), 1)
  assert.deepEqual(f.events, ['unroute'])
  assert.deepEqual(f.scenario.networkErrors, [])
})

test('draining never suppresses a genuine delayed-fetch or fulfillment failure', async () => {
  for (const stage of ['fetch', 'fulfill']) {
    const message = `unexpected ${stage} fixture failure`
    const f = fixture(stage === 'fetch' ? { fetchError: message } : { fulfillError: message })
    const held = await f.mount(), work = f.dispatch()
    f.finishFetch.resolve()
    if (stage === 'fetch') await assert.rejects(held.ready(), /unexpected fetch fixture failure/)
    else await held.ready()
    const closing = held.close()
    f.finishFulfill.resolve(); await work; await closing
    assert(f.scenario.networkErrors.some(error => error.includes(message)))
    assert(f.events.includes('aborted'))
    assert.equal(f.events.at(-1), 'unroute')
    assert.equal(f.unroutes(), 1)
  }
})
