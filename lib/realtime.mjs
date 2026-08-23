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
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim())
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
      const t = deps.getSessionTenant?.(parseCookies(req).psc_session)
      if (!t) { ws.close(4001, 'unauthorized'); return }
      slug = t.slug || ''
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
  const beat = setInterval(() => {
    for (const set of rooms.values()) {
      for (const ws of set) {
        if (ws.__alive === false) { try { ws.terminate() } catch {} set.delete(ws); continue }
        ws.__alive = false
        try { ws.ping() } catch {}
      }
    }
  }, 30000)
  beat.unref?.()
  return wss
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
