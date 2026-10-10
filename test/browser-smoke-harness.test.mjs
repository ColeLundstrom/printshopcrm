import test from 'node:test'
import assert from 'node:assert/strict'
import { appRequestAllowed, requestLabel, redact, isolateBrowser } from './browser/isolation.mjs'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('browser smoke permits only the exact demo loopback origin', () => {
  const base = 'http://127.0.0.1:4380'
  assert(appRequestAllowed(base + '/api/costing/config', base))
  assert(appRequestAllowed('ws://127.0.0.1:4380/ws', base, true))
  for (const url of ['https://example.test', 'http://localhost:4380', 'http://127.0.0.1:4381',
    'http://127.0.0.1.example.test:4380', 'http://user:password@127.0.0.1:4380',
    'https://127.0.0.1:4380', 'file:///etc/passwd', 'not a URL']) assert.equal(appRequestAllowed(url, base), false, url)
  assert.equal(appRequestAllowed(base, base, true), false)
  assert.equal(appRequestAllowed('ws://127.0.0.1:4380/ws', base), false)
  assert.equal(appRequestAllowed('https://example.test', 'https://example.test'), false)
})

test('browser evidence omits URL credentials and query strings, and redacts synthetic secrets', () => {
  assert.equal(requestLabel('https://user:secret@example.test/path?token=secret#secret'), 'https://example.test/path')
  assert.equal(redact('generated-password / generated-cookie / generated-password', ['generated-password', '', 'generated-cookie']), '[redacted] / [redacted] / [redacted]')
})

test('browser isolation blocks external HTTP and WebSockets without contacting either', async () => {
  const handlers = {}, evidence = { blockedRequests: [], networkErrors: [] }
  await isolateBrowser({ async route(_, fn) { handlers.http = fn }, async routeWebSocket(_, fn) { handlers.ws = fn } }, 'http://127.0.0.1:4380', evidence)
  let aborted = false, closed = false
  await handlers.http({ request: () => ({ url: () => 'https://example.test/?secret=hidden' }), abort: () => { aborted = true }, fetch: () => { throw Error('must not fetch') } })
  handlers.ws({ url: () => 'wss://example.test/ws', close: () => { closed = true }, connectToServer: () => { throw Error('must not connect') } })
  assert(aborted); assert(closed)
  assert.deepEqual(evidence.blockedRequests, ['https://example.test/', 'wss://example.test/ws'])
})

test('browser isolation refuses redirects instead of following an unreviewed destination', async () => {
  let handler, options, aborted = false
  const evidence = { blockedRequests: [], networkErrors: [] }
  await isolateBrowser({ async route(_, fn) { handler = fn }, async routeWebSocket() {} }, 'http://127.0.0.1:4380', evidence)
  await handler({ request: () => ({ url: () => 'http://127.0.0.1:4380/redirect' }),
    fetch: async opts => { options = opts; return { status: () => 302, headers: () => ({ location: 'https://example.test' }) } },
    abort: () => { aborted = true }, fulfill: () => { throw Error('must not fulfill redirect') } })
  assert.equal(options.maxRedirects, 0); assert(aborted)
  assert.deepEqual(evidence.blockedRequests, ['redirect from http://127.0.0.1:4380/redirect'])
})

test('browser isolation forwards unchanged HTTP responses but explicitly stubs only the app realtime socket', async () => {
  const handlers = {}, evidence = { blockedRequests: [], networkErrors: [], mockedWebSockets: [] }
  await isolateBrowser({ async route(_, fn) { handlers.http = fn }, async routeWebSocket(_, fn) { handlers.ws = fn } }, 'http://127.0.0.1:4380', evidence)
  const response = { status: () => 200, headers: () => ({}) }
  let fulfilled
  await handlers.http({ request: () => ({ url: () => 'http://127.0.0.1:4380/api/costing/config' }), fetch: async () => response, fulfill: async value => { fulfilled = value } })
  handlers.ws({ url: () => 'ws://127.0.0.1:4380/ws', connectToServer: () => { throw Error('Smoke tests must not create real realtime connections') } })
  assert.deepEqual(fulfilled, { response })
  assert.deepEqual(evidence, { blockedRequests: [], networkErrors: [], mockedWebSockets: ['ws://127.0.0.1:4380/ws'] })
  let closed = false
  handlers.ws({ url: () => 'ws://127.0.0.1:4380/unexpected', close: () => { closed = true }, connectToServer: () => { throw Error('Unexpected socket must not connect') } })
  assert(closed)
  assert.deepEqual(evidence.blockedRequests, ['ws://127.0.0.1:4380/unexpected'])
})

test('async fulfillment failures are reported without leaving an unhandled abort rejection', async () => {
  let handler
  const evidence = { blockedRequests: [], networkErrors: [], mockedWebSockets: [] }
  await isolateBrowser({ async route(_, fn) { handler = fn }, async routeWebSocket() {} }, 'http://127.0.0.1:4380', evidence)
  await assert.doesNotReject(handler({ request: () => ({ url: () => 'http://127.0.0.1:4380/api/settings' }),
    fetch: async () => ({ status: () => 200 }),
    fulfill: async () => { throw Error('route.fulfill: Route is already handled!') },
    abort: async () => { throw Error('route.abort: Route is already handled!') } }))
  assert(evidence.networkErrors.some(error => error.includes('route.fulfill: Route is already handled!')), 'Active-run failures must remain visible')
})

test('explicit close keeps guards installed and drains pending fulfillment before returning', async () => {
  let handler, closes = 0
  const filling = deferred(), result = deferred()
  const evidence = { blockedRequests: [], networkErrors: [], mockedWebSockets: [] }
  const isolation = await isolateBrowser({ async route(_, fn) { handler = fn }, async routeWebSocket() {},
    async unrouteAll() { throw Error('Never unroute a live page') },
    async close() { closes++; result.reject(Error('route.fulfill: Route is already handled!')) },
  }, 'http://127.0.0.1:4380', evidence)
  assert.equal(typeof isolation?.close, 'function')
  const pending = handler({ request: () => ({ url: () => 'http://127.0.0.1:4380/api/settings' }),
    fetch: async () => ({ status: () => 200 }),
    fulfill: async () => { filling.resolve(); return await result.promise },
    abort: async () => { throw Error('Target page, context or browser has been closed') } })
  await filling.promise
  await isolation.close(); await pending; await isolation.close()
  assert.equal(closes, 1, 'Close is idempotent')
  assert.deepEqual(evidence.networkErrors, [])
})

test('close waits for pending reads and does not start or fulfill new requests while shutting down', async () => {
  let handler, closed = false, drained = false
  const response = deferred(), reading = deferred()
  const evidence = { blockedRequests: [], networkErrors: [], mockedWebSockets: [] }
  const isolation = await isolateBrowser({ async route(_, fn) { handler = fn }, async routeWebSocket() {},
    async close() { closed = true },
  }, 'http://127.0.0.1:4380', evidence)
  assert.equal(typeof isolation?.close, 'function')
  const route = { request: () => ({ url: () => 'http://127.0.0.1:4380/api/settings' }),
    fetch: async () => { reading.resolve(); return await response.promise },
    fulfill: async () => { throw Error('Do not fulfill after close') },
    abort: async () => { throw Error('Target page, context or browser has been closed') } }
  const pending = handler(route)
  await reading.promise
  const closing = isolation.close().then(() => { drained = true })
  await Promise.resolve()
  assert(closed); assert.equal(drained, false)
  await handler({ ...route, fetch: async () => { throw Error('Do not fetch after close') } })
  response.resolve({ status: () => 200 })
  await closing; await pending
  assert(drained); assert.deepEqual(evidence.networkErrors, [])
})

test('unexpected teardown and abort errors are preserved even after close starts', async () => {
  let handler
  const response = deferred(), reading = deferred()
  const evidence = { blockedRequests: [], networkErrors: [], mockedWebSockets: [] }
  const isolation = await isolateBrowser({ async route(_, fn) { handler = fn }, async routeWebSocket() {},
    async close() { response.reject(Error('unexpected fixture failure')) },
  }, 'http://127.0.0.1:4380', evidence)
  assert.equal(typeof isolation?.close, 'function')
  const pending = handler({ request: () => ({ url: () => 'http://127.0.0.1:4380/api/settings' }),
    fetch: async () => { reading.resolve(); return await response.promise },
    abort: async () => { throw Error('unexpected abort failure') } })
  await reading.promise
  await isolation.close(); await pending
  assert(evidence.networkErrors.some(error => error.includes('unexpected fixture failure')))
  assert(evidence.networkErrors.some(error => error.includes('unexpected abort failure')))
})
