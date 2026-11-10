/**
 * A fake S&S Activewear v2 API on a loopback port, for tests and for looking at live stock in the
 * app without a distributor account. Point the server at it with
 *   SSACTIVEWEAR_API_BASE=http://127.0.0.1:<port>/v2
 * It answers the two calls lib/suppliers.mjs makes (style search, then every SKU of that style)
 * and requires Basic auth, so a missing or wrong credential fails the way the real one does.
 *
 *   node test/helpers/fake-ss.mjs 3404        # standalone
 */
import { createServer } from 'node:http'

const STYLES = [
  { styleID: 39, styleName: '5000', brandName: 'Gildan', title: 'Heavy Cotton T-Shirt' },
  { styleID: 52, styleName: '18500', brandName: 'Gildan', title: 'Heavy Blend Hooded Sweatshirt' },
  { styleID: 77, styleName: '3001', brandName: 'Bella+Canvas', title: 'Unisex Jersey Tee' },
]
const SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL']
const stockFor = (style, color, i) => {
  if (style === 39 && color === 'Black') return [1240, 18, 0, 512, 77, 9][i]
  if (style === 39 && color === 'Navy') return [300, 310, 280, 150, 40, 0][i]
  return [900, 1400, 1300, 800, 200, 60][i]
}
const COLORS = { 39: ['Black', 'Navy', 'White', 'Heather Navy'], 52: ['Black', 'Navy'], 77: ['Black', 'White'] }
const PRICE = { 39: 3.11, 52: 15.4, 77: 4.42 }

export function fakeSsHandler(expectAuth = null) {
  const seen = []
  const handler = (req, res) => {
    const u = new URL(req.url, 'http://x')
    const auth = req.headers.authorization || ''
    seen.push({ path: u.pathname + u.search, auth })
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (!/^Basic /.test(auth) || (expectAuth && auth !== expectAuth)) return json(401, { errors: [{ message: 'Invalid credentials' }] })
    if (u.pathname === '/v2/styles/') {
      const q = String(u.searchParams.get('search') || '').toLowerCase()
      return json(200, STYLES.filter((s) => s.styleName.toLowerCase() === q || s.title.toLowerCase().includes(q)))
    }
    if (u.pathname === '/v2/products/') {
      const id = Number(u.searchParams.get('styleid'))
      const style = STYLES.find((s) => s.styleID === id)
      if (!style) return json(404, { errors: [{ message: 'Requested item(s) were not found' }] })
      const rows = []
      for (const color of COLORS[id]) SIZES.forEach((size, i) => rows.push({
        sku: `B${String(id).padStart(3, '0')}${String(COLORS[id].indexOf(color)).padStart(2, '0')}${i}`, brandName: style.brandName, styleName: style.styleName,
        colorName: color, sizeName: size, qty: stockFor(id, color, i), customerPrice: PRICE[id] + (i >= 4 ? 1.9 : 0), piecePrice: PRICE[id] + 1,
      }))
      return json(200, rows)
    }
    json(404, { errors: [{ message: 'Not found' }] })
  }
  handler.seen = seen
  return handler
}

/** Start it on an OS-assigned (or given) port. Resolves to { port, base, seen, close }. */
export function startFakeSs({ port = 0, expectAuth = null } = {}) {
  const handler = fakeSsHandler(expectAuth)
  const server = createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port, base: `http://127.0.0.1:${server.address().port}/v2`, seen: handler.seen,
      close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()) }),
    }))
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFakeSs({ port: Number(process.argv[2]) || 3404 })
  console.log(`fake S&S listening — SSACTIVEWEAR_API_BASE=${s.base}`)
}
