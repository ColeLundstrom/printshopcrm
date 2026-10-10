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
  let closing = false, closePromise
  const pending = new Set()
  const expectedClose = error => closing && /^(?:[\w.]+: )?(?:Target page, context or browser has been closed|Target closed|Browser has been closed|Route is already handled!)(?:\n|$)/.test(String(error?.message || error))
  const record = (url, error) => {
    if (!expectedClose(error)) evidence.networkErrors.push(requestLabel(url) + ': ' + String(error?.message || error))
  }
  const track = (url, action) => {
    // Route callbacks are event handlers: an escaped rejected promise crashes the process
    // instead of becoming an assertion failure. Record every unexpected error and drain it.
    const task = (async () => { try { await action() } catch (error) { record(url, error) } })()
    pending.add(task)
    void task.then(() => pending.delete(task))
    return task
  }
  const abort = async (route, reason, url) => {
    try { await route.abort(reason) } catch (error) { record(url, error) }
  }
  await context.route('**/*', route => {
    const url = route.request().url()
    return track(url, async () => {
      if (!appRequestAllowed(url, base)) {
        evidence.blockedRequests.push(requestLabel(url))
        await abort(route, 'blockedbyclient', url)
        return
      }
      if (closing) { await abort(route, 'aborted', url); return }
      try {
        // Fetch exactly one response; redirects must never escape the origin guard.
        const response = await route.fetch({ maxRedirects: 0, timeout: 15000 })
        if (closing) { await abort(route, 'aborted', url); return }
        if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
          evidence.blockedRequests.push('redirect from ' + requestLabel(url))
          await abort(route, 'blockedbyclient', url)
          return
        }
        await route.fulfill({ response })
      } catch (error) {
        record(url, error)
        if (!expectedClose(error)) await abort(route, 'failed', url)
      }
    })
  })
  await context.routeWebSocket('**/*', socket => {
    const url = socket.url()
    return track(url, async () => {
      if (appRequestAllowed(url, base, true) && new URL(url).pathname === '/ws' && !new URL(url).search) {
        // Documented mock mode opens only an in-page socket. Realtime is not under test.
        if (!closing) evidence.mockedWebSockets.push(requestLabel(url))
        return
      }
      evidence.blockedRequests.push(requestLabel(url))
      await socket.close({ code: 1008, reason: 'Synthetic local demo only' })
    })
  })
  return {
    close() {
      if (!closePromise) {
        closing = true
        closePromise = (async () => {
          // Keep the guards installed until the context is closed. Unrouting a live page
          // can expose a final request and race Playwright's own route cancellation.
          try { await context.close() } catch (error) { record(base, error) }
          finally { while (pending.size) await Promise.all([...pending]) }
        })()
      }
      return closePromise
    },
  }
}
