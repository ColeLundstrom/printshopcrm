import test from 'node:test'
import assert from 'node:assert/strict'
import { appRequestAllowed, requestLabel, redact, isolateBrowser } from './browser/isolation.mjs'

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
