/**
 * Floor-mode service worker: keep the app shell usable when shop wifi drops (the category-wide
 * complaint: "Yesterday it was nearly useless… I was unable to access the notes/submitted files").
 *
 * Deliberately does NOT cache API responses. An earlier version cached every authenticated
 * GET /api/* into an origin-wide bucket keyed only by URL — and every shop shares this origin
 * (the tenant comes from the session cookie, not the hostname). Nothing bound an entry to the
 * session that fetched it and nothing cleared it on logout, so on a shared floor tablet the next
 * person to open the app offline could be served the previous shop's customers, invoice totals
 * and statement PDFs. Offline convenience is not worth cross-tenant data disclosure.
 *
 * Strategy now:
 *   - App shell (/, JS, CSS, icons): network first; cached shell only when the network is unavailable.
 *   - Anything under /api/, /p/, /uploads/: network only, never stored.
 *   - Non-GET (writes, uploads, auth): untouched — never fake a write.
 *
 * `CLEAR_CACHES` from the page (sent on logout) wipes everything, belt and braces.
 */
const SHELL = 'psc-shell-v3'

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  // Drops psc-data-v1 from any previously-installed worker along with every other stale bucket.
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// The page asks for a full wipe when someone signs out.
self.addEventListener('message', (e) => {
  if (e.data === 'CLEAR_CACHES') e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))))
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return

  // Tenant-scoped or personal data: always straight to the network, never stored on the device.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/p/')
      || url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/ws')) return

  // Only known public shell assets belong in the offline cache. Never cache login pages,
  // documents or arbitrary future endpoints just because they are GET requests.
  const shell = url.pathname === '/' || ['/manifest.json','/icon.svg'].includes(url.pathname)
    || /^\/(css|js|fonts|icons)\//.test(url.pathname)
  if (!shell) return

  // Returning cached HTML/JS/CSS while refreshing them independently mixed releases: a new
  // view could load with the previous stylesheet or module exports. Online requests must all
  // read the current release. HTTP errors are real failures; only a network failure uses cache.
  const response = fetch(req, {cache:'no-cache'}).then(async (res) => {
    if (res.ok) {
      try { const c=await caches.open(SHELL);await c.put(req,res.clone()) } catch { /* storage full */ }
    }
    return res
  }).catch(async () => {
    const hit=await caches.match(req)
    return hit || new Response('Offline. Reconnect to load PrintShopCRM. Your shop data remains on the server.', {status:503,headers:{'Content-Type':'text/plain'}})
  })
  e.respondWith(response)
})
