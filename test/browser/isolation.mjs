/** The browser may talk only to the synthetic demo's exact loopback origin. */
export function appRequestAllowed(value, base, webSocket = false) {
  try {
    const origin = new URL(base), url = new URL(value)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password) return false
    return url.protocol === (webSocket ? 'ws:' : 'http:') && url.hostname === '127.0.0.1'
      && url.port === origin.port && !url.username && !url.password
  } catch { return false }
}

// Never save query strings, auth headers, cookies, or generated demo credentials in evidence.
export function requestLabel(value) {
  try { const url = new URL(value); return url.origin + url.pathname } catch { return '(invalid URL)' }
}

export function redact(value, secrets) {
  return secrets.filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value))
}

export async function isolateBrowser(context, base, evidence) {
  if (!appRequestAllowed(base, base)) throw Error('Browser smoke requires an exact HTTP 127.0.0.1 origin')
  await context.route('**/*', async route => {
    const url = route.request().url()
    if (!appRequestAllowed(url, base)) {
      evidence.blockedRequests.push(requestLabel(url))
      return route.abort('blockedbyclient')
    }
    try {
      // route.continue() can allow redirect chains past a route handler. Fetch one response
      // at a time, without following redirects, and refuse redirects altogether in this fixture.
      const response = await route.fetch({ maxRedirects: 0, timeout: 15000 })
      if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
        evidence.blockedRequests.push('redirect from ' + requestLabel(url))
        return route.abort('blockedbyclient')
      }
      return route.fulfill({ response })
    } catch (error) {
      evidence.networkErrors.push(requestLabel(url) + ': ' + error.message)
      return route.abort('failed')
    }
  })
  await context.routeWebSocket('**/*', socket => {
    if (appRequestAllowed(socket.url(), base, true) && new URL(socket.url()).pathname === '/ws' && !new URL(socket.url()).search) {
      // The planner does not depend on realtime. Playwright's documented mock mode
      // opens this socket in-page without a network connection when connectToServer
      // is omitted. Keep Chrome's local-network checks intact; this is not realtime QA.
      evidence.mockedWebSockets.push(requestLabel(socket.url()))
      return
    }
    evidence.blockedRequests.push(requestLabel(socket.url()))
    return socket.close({ code: 1008, reason: 'Synthetic local demo only' })
  })
}
