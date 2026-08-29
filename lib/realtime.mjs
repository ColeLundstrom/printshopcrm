/**
 * Real-time layer — a thin WebSocket broadcast bus attached to the HTTP server.
 *
 * Every shop is its own room (keyed by tenant slug; empty string in single-tenant dev).
 * The server pushes small JSON events — a job moved, a new message arrived, a lead came in —
 * and connected browsers react live: the board reshuffles, the inbox badge ticks, a toast
 * pops. It is purely additive; if the socket never connects, the app still works on refresh.
 *
 * Auth reuses the same session cookie the REST API uses, resolved via the injected
 * getSessionTenant so a socket can only ever join its own shop's room.
 */
import { WebSocketServer } from 'ws'

let wss = null
let beat = null
const rooms = new Map() // slug -> Set<ws>

const roomOf = (slug) => {
  const key = slug || ''
  if (!rooms.has(key)) rooms.set(key, new Set())
  return rooms.get(key)
}

const parseCookies = (req) => {
  const out = {}
  ;(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=')
    if (i <= 0) return
    const raw = p.slice(i + 1).trim()
    // decodeURIComponent THROWS on a malformed percent-escape ("%", "%zz"), and a cookie is
    // attacker-controlled. server.mjs was hardened against this; this second copy was not, and it
    // runs on the /ws upgrade BEFORE any auth — so a bad cookie threw out of the connection
    // handler, the socket was never closed, and the fd was never reaped. Repeated unauthenticated
    // upgrades exhausted file descriptors for the whole multi-tenant process.
    let val = raw
    try { val = decodeURIComponent(raw) } catch { /* keep the raw bytes */ }
    out[p.slice(0, i).trim()] = val
  })
  return out
}

/**
 * Attach the WS server. `deps.authEnabled` gates whether we resolve a tenant from the cookie;
 * `deps.getSessionTenant(token)` returns the shop for a session (same fn the REST gate uses).
 */
export function initRealtime(server, deps = {}) {
  wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws, req) => {
    let slug = ''
    if (deps.authEnabled) {
      // Anything that throws while resolving the session must still close the socket. An orphaned
      // upgrade holds its fd until the process dies, and this path is reachable by anyone.
      const tok = parseCookies(req).psc_session
      let t = null
      try { t = deps.getSessionTenant?.(tok) } catch (e) { console.error('ws auth:', e.message) }
      if (!t) { ws.close(4001, 'unauthorized'); return }
      slug = t.slug || ''
      // Keep the token so the heartbeat can ask the question again. A socket was authorised ONCE,
      // at upgrade, and never re-checked: measured, `POST /api/auth/logout` returned 200, the
      // session row was deleted, `GET /api/auth/me` on the same cookie correctly answered
      // authed:false — and the socket stayed OPEN and received the next board event. Nothing in
      // the product closed it; no route iterates wss.clients and closeRealtime() only runs at
      // shutdown. The same held for a member who had been deactivated and for a shop that had
      // been suspended, which is the operator's only lever against a shop defrauding people.
      ws.__token = tok
    }
    ws.__slug = slug
    ws.__alive = true
    roomOf(slug).add(ws)
    ws.on('pong', () => { ws.__alive = true })
    ws.on('close', () => roomOf(slug).delete(ws))
    ws.on('error', () => roomOf(slug).delete(ws))
    ws.on('message', (raw) => {
      // The only inbound message is a ping keepalive from idle tabs.
      try { const m = JSON.parse(String(raw)); if (m.type === 'ping') ws.send('{"type":"pong"}') } catch { /* ignore */ }
    })
    try { ws.send(JSON.stringify({ type: 'hello', slug })) } catch { /* ignore */ }
  })

  // Drop dead sockets so rooms don't leak.
  clearInterval(beat)
  beat = setInterval(() => {
    for (const set of rooms.values()) {
      for (const ws of set) {
        // Still entitled to be here? getSessionTenant already returns null for a deleted session,
        // a deactivated member and a suspended shop, so one call answers all three.
        if (ws.__token) {
          let still = null
          try { still = deps.getSessionTenant?.(ws.__token) } catch { still = null }
          if (!still || (still.slug || '') !== ws.__slug) {
            try { ws.close(4001, 'signed out') } catch { /* already gone */ }
            set.delete(ws)
            continue
          }
        }
        if (ws.__alive === false) { try { ws.terminate() } catch {} set.delete(ws); continue }
        ws.__alive = false
        try { ws.ping() } catch {}
      }
    }
  }, Number(process.env.PSC_WS_HEARTBEAT_MS) || 30000)
  beat.unref?.()
  return wss
}

/**
 * Stop the live layer so a deploy can actually drain.
 *
 * `server.close()` waits for every open connection to end, and an upgraded WebSocket never ends by
 * itself — so ONE browser tab left open anywhere in the shop pushed every SIGTERM through to the
 * 8s hard-exit timer in server.mjs. Measured on this repo: 8016 ms to exit with a single socket
 * open, 14 ms with none. The hard exit is `process.exit(0)`, which severs whatever request was
 * in flight, so the cost was not only eight seconds of a deploy — it was the one code path that
 * was supposed to make a deploy safe never running.
 *
 * 1001 "going away" is exactly what the browser's reconnect backoff in public/js/app.js is written
 * for, so an open tab reattaches to the new process about a second later on its own.
 */
export function closeRealtime() {
  clearInterval(beat)
  beat = null
  const server = wss
  wss = null
  if (!server) return Promise.resolve()
  for (const set of rooms.values()) {
    for (const ws of set) { try { ws.close(1001, 'server restarting') } catch { /* already gone */ } }
  }
  rooms.clear()
  return new Promise((resolve) => {
    // A client that ignores a close frame must not be able to hold the deploy open either.
    const hard = setTimeout(() => {
      for (const ws of server.clients) { try { ws.terminate() } catch { /* already gone */ } }
      resolve()
    }, 1000)
    hard.unref?.()
    server.close(() => { clearTimeout(hard); resolve() })
  })
}

/** Broadcast an event to one shop's room. `type` is the event name, `data` its payload. */
export function broadcast(slug, type, data = {}) {
  const set = rooms.get(slug || '')
  if (!set || !set.size) return
  const msg = JSON.stringify({ type, data, at: Date.now() })
  for (const ws of set) {
    if (ws.readyState === 1) { try { ws.send(msg) } catch {} }
  }
}

/** How many browsers a shop currently has open — surfaced in the UI as a presence dot. */
export const roomSize = (slug) => (rooms.get(slug || '')?.size || 0)
