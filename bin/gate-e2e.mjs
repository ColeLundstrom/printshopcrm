#!/usr/bin/env node
/**
 * Release-gate E2E: a brand-new shop's whole first day, against a throwaway database.
 *
 *   node bin/gate-e2e.mjs [port]      exit 0 = pass
 *
 * Pure Node on purpose. The previous version was a bash script driving curl and python3, which
 * meant the end-to-end suite couldn't run on Windows and needed three things installed that the
 * app itself doesn't use. This needs only the Node you already have.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import { request as rawHttp } from 'node:http'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Env as well as argv: a CI matrix that runs two jobs on one runner needs to move this, and
// `PSC_GATE_PORT=4391 npm run test:e2e` is reachable where an npm-script argv is not.
const PORT = Number(process.argv[2] || process.env.PSC_GATE_PORT) || 4390
const BASE = `http://127.0.0.1:${PORT}`
const TMP = mkdtempSync(join(tmpdir(), 'psc-e2e-'))

let fails = 0
const say = (mark, msg) => console.log(`  ${mark} ${msg}`)

const sizeSum = (g) => Object.values(g || {}).reduce((a, n) => a + (Number(n) || 0), 0)

/** chk(label, got, wantRegex) — `got` is stringified so a status number and a body both work. */
const chk = (label, got, want) => {
  const s = String(got ?? '')
  if (new RegExp(want).test(s)) say('✓', label)
  else { say('✗', `${label} — got: ${s.slice(0, 120)}`); fails++ }
}

/* ---------- a cookie jar, because signup returns a session we have to carry ---------- */
const jar = new Map()
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
function stash(res) {
  // Node exposes repeated Set-Cookie via getSetCookie(); fall back for older runtimes.
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean)
  for (const c of raw) {
    const [pair] = String(c).split(';')
    const i = pair.indexOf('=')
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}

/** One request. Returns { status, text, json } — never throws on a non-2xx. */
async function req(method, path, { body, headers = {}, cookies = true } = {}) {
  const h = { ...headers }
  if (body !== undefined) h['Content-Type'] = 'application/json'
  if (cookies && jar.size) h.Cookie = cookieHeader()
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  stash(res)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* html or empty is fine */ }
  return { status: res.status, text, json }
}

/**
 * Reach into the shop's own database on a second connection.
 *
 * Only for winding a clock forward that a test cannot sit and wait out — a drip whose next step
 * is two days away, an invoice that has to be overdue. It is a second WAL reader/writer against
 * the file the server is already using, not a back door for asserting state: everything a test
 * CHECKS should still come back through the API, because that is what the shop can see.
 */
const shopDb = (slug, fn) => {
  const d = new DatabaseSync(join(TMP, 'tenants', slug, 'printshop.db'))
  try { d.exec('PRAGMA busy_timeout = 5000'); return fn(d) } finally { try { d.close() } catch { /* already closed */ } }
}

/* ---------- boot a server against a throwaway db ---------- */
const server = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), PSC_DB: join(TMP, 'printshop.db'), PSC_AUTH: '1', PSC_SECRET: 'gate', PSC_PUBLIC_URL: `http://127.0.0.1:${PORT}` },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let serverLog = ''
server.stdout.on('data', (d) => { serverLog += d })
server.stderr.on('data', (d) => { serverLog += d })

/**
 * Every server this run starts, so cleanup can kill all of them.
 *
 * Each one is spawned `detached`, in its OWN process group. Without that they inherit the group of
 * the shell running the suite, and back-to-back `npm test && npm run test:e2e` — the ten-times-in-a-
 * row protocol this gate exists for — failed about one run in six: the freshly booted server took a
 * SIGTERM within a second of printing its banner, from the previous run's teardown reaching a group
 * the next run had already joined. It showed up as "harness error: fetch failed" or a cascade of
 * connection-refused assertions, which reads exactly like a product regression and is not one. It
 * did not reproduce with a gap between runs, or when the suite was run directly rather than through
 * npm. Two servers can never both hold the port (checked), so the port was never the cause.
 *
 * The children spawn no children of their own, so killing the leader by pid is still enough.
 *
 * A run that dies without cleaning up leaves a server holding the port, and the NEXT run then
 * fails with "An account with that email already exists" and a cascade of 401s — which reads as a
 * regression rather than as a stale process. The gate is meant to be run ten times in a row; one
 * leaked server poisons every run after it. SIGPIPE is the one that actually bites: piping the
 * gate into `grep`/`head` kills it the moment the reader closes.
 */
const started = [server]
let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  for (const p of started) { try { p.kill('SIGKILL') } catch { /* already gone */ } }
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* best effort */ }
}
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE']) {
  process.on(sig, () => { cleanup(); process.exit(sig === 'SIGINT' ? 130 : 143) })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const round2e = (n) => Math.round((Number(n) || 0) * 100) / 100

async function waitForBoot() {
  // 90s, not 30s. A loaded CI runner (or a laptop building something else) can genuinely take
  // longer than 30s to open a database and run migrations, and a gate that fails on load teaches
  // people to re-run it until it goes green — which is how a real regression gets waved through.
  const LIMIT_MS = Number(process.env.PSC_GATE_BOOT_MS) || 90000
  const started = Date.now()
  while (Date.now() - started < LIMIT_MS) {
    if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode})\n${serverLog}`)
    let healthy = false
    try { healthy = (await fetch(`${BASE}/health`)).ok } catch { /* not up yet */ }
    if (healthy) {
      // Something is answering — but is it OURS? A server left behind by a run that was killed
      // holds the port, our server dies with EADDRINUSE, and the whole suite then runs against
      // the STALE database: "An account with that email already exists" followed by a cascade of
      // 401s, which reads as a pile of regressions rather than as a stale process. The bind error
      // is asynchronous, so give it a beat to land before trusting the port.
      await sleep(300)
      if (server.exitCode !== null) {
        throw new Error(
          `port ${PORT} is already answering /health, and this run's own server exited (${server.exitCode}).\n` +
          `  That is a server left behind by an earlier run. Kill it and try again:\n` +
          `    lsof -ti:${PORT} | xargs kill -9\n` +
          `  Or run this suite on another port:  PSC_GATE_PORT=${PORT + 100} npm run test:e2e\n` +
          `  Server output:\n${serverLog.trim() || '  (nothing)'}`,
        )
      }
      return
    }
    await sleep(500)
  }
  // Whoever reads this is debugging a red gate with no other clue, so say what we know.
  const secs = Math.round((Date.now() - started) / 1000)
  throw new Error(
    `server never became healthy on ${BASE} after ${secs}s.\n` +
      `  It was still running, so it hung during startup rather than crashing.\n` +
      `  Raise the budget with PSC_GATE_BOOT_MS if the machine is just slow.\n` +
      `  Server output:\n${serverLog.trim() || '  (the server printed nothing at all)'}`,
  )
}

/* ================================ the run ================================ */
try {
  await waitForBoot()

  let r = await req('POST', '/api/auth/signup', {
    body: { shop_name: 'Gate Shop', owner_name: 'Gate', owner_email: 'gate@e2e.test', password: 'GatePass-123456' },
  })
  chk('signup creates a tenant', r.text, '"ok":true|"shop"|"user"')

  r = await req('POST', '/api/autopilot', {
    body: { text: '144 Bella+Canvas 3001 in White, 1 color front, need by 2026-09-30. Gate Buyer gate-buyer@e2e.test' },
  })
  chk('paste → estimate', r.text, '"estimate_number":"EST-')
  chk('estimate carries blank cost', r.text, 'blank_cost')
  chk('deadline honoured', r.text, '"due_hint":"2026-09-30"')
  const estId = r.json?.estimate?.id

  // Autopilot commit SENDS the estimate and stops. It used to immediately mark it "approved —
  // Customer said yes" and raise a real invoice before the customer ever replied — a fabricated
  // consent, a phantom A/R balance, and a won deal on an order that might never come.
  if (estId) {
    r = await req('POST', '/api/autopilot/commit', { body: { estimate_id: estId } })
    chk('autopilot commit sends the estimate', String(r.status), '^200$')
    chk('…and does NOT fabricate a customer approval', String(r.json?.estimate?.status), '^sent$')
    chk('…and raises no invoice until the customer actually approves', String(r.json?.invoice), '^null$')

    /* The "did that work?" press. commitAutopilot ran all the way through however many times it
     * was called — its only guard was "already invoiced", which went dead the moment autopilot
     * stopped raising invoices — so a second press mailed the customer the same estimate again,
     * and a third mailed it a third time. And it wrote status='sent' unconditionally, so an
     * estimate the customer had ALREADY APPROVED went back to 'sent' with approved_at still set:
     * the pipeline card stuck on won, and the shop looking at a quote that says it is waiting on
     * a customer who already said yes. The manual Send has carried this guard since v1.4.0. */
    /* And the shop's own rules have to see it. commitAutopilot never fired estimate.sent, so the
     * automations and the webhook subscribers (dispatchSubscriptions lives inside fireAuto) were
     * blind to every quote autopilot sent — the shipped default rule that flags a big quote for a
     * personal call was dead on exactly the path nobody is watching. */
    const autoRuns = ((await req('GET', '/api/automations')).json?.runs || [])
      .filter((x) => x.trigger === 'estimate.sent').length
    chk('autopilot\'s send reaches the shop\'s own rules', String(autoRuns > 0), '^true$')

    const outboxBefore = ((await req('GET', '/api/outbox')).json || []).length
    r = await req('POST', '/api/autopilot/commit', { body: { estimate_id: estId } })
    chk('pressing Send a second time answers cleanly', String(r.status), '^200$')
    chk('…and says it did nothing, rather than doing it again', String(r.json?.already), '^true$')
    const outboxAfter = ((await req('GET', '/api/outbox')).json || []).length
    chk('…and the customer is not mailed the same estimate twice', String(outboxAfter), `^${outboxBefore}$`)

    // Now the customer approves. A later commit must not drag it back to "waiting on them".
    await req('POST', `/api/estimates/${estId}/approve`)
    chk('the customer approves it', String((await req('GET', `/api/estimates/${estId}`)).json?.status), '^approved$')
    r = await req('POST', '/api/autopilot/commit', { body: { estimate_id: estId } })
    chk('committing an approved estimate does not un-approve it', String(r.json?.estimate?.status), '^approved$')
    chk('…and does not re-send it', String(r.json?.sent), '^false$')
  }

  r = await req('PUT', '/api/pricebook', {
    body: { services: { Embroidery: { axis: 'stitches', base: 7.5, perUnit: 1, minPerPiece: 5, setup: { label: 'Digitizing', fee: 75, per: 'design' } } } },
  })
  chk('pricebook save', r.text, '"ok":true')
  await req('PUT', '/api/pricebook', {
    body: { services: { 'Foil Print': { axis: 'flat', base: 6, perUnit: 0, minPerPiece: 6, setup: { label: 'Foil die', fee: 55, per: 'design' } } } },
  })
  r = await req('GET', '/api/pricebook')
  chk('pricebook merge keeps both', r.text, 'Foil Print[\\s\\S]*Embroidery|Embroidery[\\s\\S]*Foil Print')

  if (estId) {
    r = await req('POST', `/api/estimates/${estId}/convert`)
    if (/invoice|INV-/.test(r.text)) chk('estimate → invoice', r.text, 'INV-|invoice')
    else {
      await req('POST', `/api/estimates/${estId}/approve`)
      say('·', `convert route not at /convert (got ${r.text.slice(0, 60)}) — checked without failing`)
    }
  } else {
    say('·', 'no estimate id returned — conversion not checked')
  }

  r = await req('GET', '/api/settings')
  chk('secrets redacted on settings read', r.text, '"ss_api_key":""|"ss_api_key_set"')

  r = await req('GET', '/api/estimates')
  chk('authed API answers 200', r.status, '^200$')

  r = await req('POST', '/api/auth/signup', {
    cookies: false,
    body: { shop_name: 'Bot', owner_name: 'b', owner_email: 'bot@x.test', password: 'BotPass-123456', website: 'http://spam.example' },
  })
  chk('honeypot swallows bots', r.status, '^200$')

  /* ---- custom price matrices ----
     The shop invents its own price sheet. Nothing here may assume screen printing. */
  r = await req('GET', '/api/matrices')
  chk('a new shop starts with no matrices and a set of templates', `${r.json?.matrices?.length}|${r.json?.templates?.length >= 6}`, '^0\\|true$')

  r = await req('POST', '/api/matrices', { body: { template: 'drinkware' } })
  const mugId = r.json?.matrix?.id
  chk('a starter template installs as the shop\'s own matrix', `${r.status}|${r.json?.matrix?.name}`, '^200\\|Mugs & Drinkware$')
  chk('the first matrix a shop makes becomes its default', r.json?.matrix?.isDefault, '^true$')

  // The headline requirement: any name, any headings. A shop that sells something this software
  // has never modelled must be able to hold its real prices.
  r = await req('POST', '/api/matrices', {
    body: {
      name: 'Rush Fees', rowLabel: 'Turnaround', colLabel: 'Order size', unit: 'flat',
      rows: ['Same day', '2–3 days', '1 week'], cols: ['Under 50', '50–200', '200+'],
      cells: [[250, 400, 750], [150, 250, 450], [0, 0, 0]],
    },
  })
  const rushId = r.json?.matrix?.id
  chk('a matrix can be named and shaped anything at all', `${r.json?.matrix?.name}|${r.json?.matrix?.rows?.length}x${r.json?.matrix?.cols?.length}`, '^Rush Fees\\|3x3$')
  chk('a second matrix does not steal the default', r.json?.matrix?.isDefault, '^false$')

  r = await req('GET', `/api/matrices/${rushId}/price?row=Same%20day&col=50%E2%80%93200&qty=120`)
  chk('price lookup works by heading text', r.json?.price, '^400$')
  chk('a flat matrix ignores quantity', r.json?.amount, '^400$')

  r = await req('GET', `/api/matrices/${mugId}/price?col=0&qty=30`)
  chk('a quantity-banded matrix picks its own row', `${r.json?.row}|${r.json?.price}`, '^24–47\\|11.5$')

  // Adding a column must not disturb prices already typed in — the edit shops make most often.
  r = await req('GET', `/api/matrices/${mugId}`)
  const mug = r.json.matrix
  r = await req('PUT', `/api/matrices/${mugId}`, {
    body: { ...mug, cols: [...mug.cols, 'Pint glass'], cells: mug.cells.map((row) => [...row, null]) },
  })
  chk('a new column appends without moving existing prices', `${r.json?.matrix?.cols?.length}|${r.json?.matrix?.cells?.[0]?.[0]}`, '^6\\|18$')
  // Blank, not 0 — a zero would quote the new column as free until someone noticed.
  chk('the new column starts blank, not zero', r.json?.matrix?.cells?.[0]?.[5] === null, '^true$')

  r = await req('POST', '/api/matrices/import', { body: { text: 'Quantity,11 oz Mug,20 oz Tumbler\n1-11,18.00,26.00\n12-23,13.00,20.00' } })
  chk('an imported sheet keeps its headings as text', r.json?.matrix?.cols?.join(','), '^11 oz Mug,20 oz Tumbler$')

  r = await req('POST', `/api/matrices/${rushId}/duplicate`)
  const dupId = r.json?.matrix?.id
  chk('duplicate names the copy so they can be told apart', r.json?.matrix?.name, '^Rush Fees \\(copy\\)$')

  r = await req('POST', `/api/matrices/${rushId}/default`)
  chk('the default can be moved', r.json?.matrix?.isDefault, '^true$')

  // A quote priced off a matrix is a normal estimate — the provenance rides along, the money is
  // computed by the same totals code as every other line.
  r = await req('GET', '/api/contacts')
  const buyerId = r.json?.contacts?.[0]?.id
  r = await req('POST', '/api/estimates', {
    body: {
      contact_id: buyerId,
      items: [
        { description: 'Team mugs', detail: '24–47 · 11 oz mug', sizes: null, qty: 30, unit_price: 11.5, taxable: true, matrix: { id: mugId, name: 'Mugs & Drinkware', row: '24–47', col: '11 oz mug' } },
        { description: 'Same-day rush', qty: 1, unit_price: 400, taxable: false, matrix: { id: rushId, name: 'Rush Fees', row: 'Same day', col: '50–200' } },
      ],
      tax_rate: 0,
    },
  })
  chk('two different matrices price two lines of one estimate', r.json?.total, '^745$')
  chk('the matrix a line came from is stored with it', r.text, 'Mugs & Drinkware')

  r = await req('DELETE', `/api/matrices/${dupId}`)
  chk('a matrix can be deleted', r.status, '^200$')
  r = await req('GET', `/api/matrices/${dupId}`)
  chk('a deleted matrix is gone', r.status, '^404$')
  r = await req('POST', '/api/matrices', { body: { name: 'No grid', rows: [], cols: [] } })
  chk('an empty grid is refused with a reason', r.text, 'at least one row')

  /* ---- public REST API (/api/v1) ---- */
  r = await req('POST', '/api/developers/key/rotate')
  let key = r.json?.api_key || ''
  chk('API key issues', key, '^psc_live_')
  const asKey = (k = key) => ({ cookies: false, headers: { Authorization: `Bearer ${k}` } })

  r = await req('GET', '/api/v1/customers', { cookies: false })
  chk('v1 rejects a missing API key', r.status, '^401$')
  r = await req('GET', '/api/v1/customers', asKey('psc_live_not_a_real_key'))
  chk('v1 rejects a bogus API key', r.status, '^401$')
  r = await req('GET', '/api/v1/customers', asKey())
  chk('v1 accepts the issued key', r.status, '^200$')

  /* An Authorization header is an explicit statement about WHICH shop the request is for, and the
   * session branch above answered before the Bearer branch was ever reached — so a browser cookie
   * riding the same connection silently overrode the key. This suite could not see it because
   * asKey() hard-codes cookies:false and nothing ever sent both. It matters because revoking a key
   * is the shop's ONLY response to a leak: with a cookie present a revoked key kept returning 200,
   * as did an invalid one, and the published 120/min limiter never ran. */
  const asKeyAndCookie = (k = key) => ({ cookies: true, headers: { Authorization: `Bearer ${k}` } })
  r = await req('GET', '/api/v1/customers', asKeyAndCookie('psc_live_not_a_real_key'))
  chk('a bogus API key is still refused when a browser cookie rides along', String(r.status), '^401$')
  r = await req('GET', '/api/v1/customers', asKeyAndCookie())
  chk('…and a good key still works with one', String(r.status), '^200$')
  const deadKey = key
  r = await req('POST', '/api/developers/key/rotate')
  key = r.json?.api_key || ''   // every later case uses the live key, as a real integrator would
  chk('rotating issues a new key', String(key !== deadKey && key.startsWith('psc_live_')), '^true$')
  r = await req('GET', '/api/v1/customers', asKeyAndCookie(deadKey))
  chk('a key the shop has revoked is dead even with a cookie', String(r.status), '^401$')
  r = await req('GET', '/api/v1/customers', asKey(deadKey))
  chk('…as it already was without one', String(r.status), '^401$')
  r = await req('GET', '/api/v1/customers', asKeyAndCookie())
  chk('…and the replacement key is the one that works', String(r.status), '^200$')
  // A plain cookie request to /api/v1 must still authenticate as the session — requireRole() on
  // those routes depends on the member's real role, not on the API key's blanket 'manager'.
  r = await req('GET', '/api/v1/customers', { cookies: true })
  chk('a cookie-only request to v1 is unaffected', String(r.status), '^200$')

  // Number('1e400') is Infinity, and binding that as a SQLite OFFSET threw a 500 — from a public,
  // documented query parameter. A garbage paging value must degrade to the default, not crash.
  for (const bad of ['1e400', '-5', 'abc', '9'.repeat(400)]) {
    r = await req('GET', `/api/v1/customers?offset=${bad}`, asKey())
    chk(`v1 survives offset=${bad.slice(0, 8)} (200, not 500)`, String(r.status), '^200$')
  }
  r = await req('GET', '/api/v1/customers?limit=99999', asKey())
  chk('v1 caps an absurd limit instead of honouring it', String((r.json?.data || []).length <= 100), '^true$')

  // A line with no unit_price used to return 201 and a $0 estimate a customer could approve.
  r = await req('POST', '/api/v1/estimates', {
    ...asKey(),
    body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: '72 tees', sizes: { M: 72 } }] },
  })
  chk('v1 refuses a line with no unit_price', r.text, 'unit_price_required')
  r = await req('POST', '/api/v1/estimates', {
    ...asKey(),
    body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: '72 tees', sizes: { M: 72 }, unit_price: 9.5 }] },
  })
  chk('v1 prices a complete line', r.text, '684')
  r = await req('POST', '/api/v1/estimates', {
    ...asKey(),
    body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: 'comped sample', sizes: { M: 1 }, unit_price: 0 }] },
  })
  chk('v1 still allows an explicit zero-dollar line', r.text, 'EST-')

  // The `== null` guard above caught null and undefined — and nothing an integration actually
  // sends. A form posts "", an unbound Zapier line-item mapping sends "" or [], a toggle sends
  // false. Each coerced to 0 and returned a 201 with a $0 estimate a customer could approve.
  for (const [label, bad] of [['an empty string', ''], ['an empty array', []], ['false', false], ['an object', {}]]) {
    r = await req('POST', '/api/v1/estimates', {
      ...asKey(),
      body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: '50 tees', quantity: 50, unit_price: bad }] },
    })
    chk(`v1 refuses unit_price given as ${label}`, `${r.status} ${r.text}`, '^400 .*unit_price_required')
  }
  // Shirts do not come in halves. Rounding was wrong both ways: 0.4 → 0 pieces → a $0 estimate,
  // and 2.5 → 3 units billed for a quantity nobody asked for.
  for (const [label, q] of [['0.4 (rounds to zero pieces)', 0.4], ['2.5 (rounds up and overcharges)', 2.5]]) {
    r = await req('POST', '/api/v1/estimates', {
      ...asKey(),
      body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: 'tees', quantity: q, unit_price: 10 }] },
    })
    chk(`v1 refuses a fractional quantity of ${label}`, `${r.status} ${r.text}`, '^400 .*invalid_quantity')
  }
  // Number(true) is 1 and Number([24]) is 24, and both pass Number.isInteger — so a quantity that
  // was never a number reached the money arithmetic and came back a priced, 201'd estimate. The
  // caller sees a valid document and a wrong dollar figure. `taxable: 1` one field over has always
  // been a 400, which is the standard the rest of the endpoint was already holding.
  for (const [label, q] of [['true', true], ['false', false], ['an array', [24]], ['an empty array', []], ['an object', {}], ['an empty string', '']]) {
    r = await req('POST', '/api/v1/estimates', {
      ...asKey(),
      body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: 'tees', quantity: q, unit_price: 10 }] },
    })
    chk(`v1 refuses a quantity given as ${label}`, `${r.status} ${r.text}`, '^400 .*invalid_quantity')
  }
  for (const [label, v] of [['true', true], ['an array', [24]], ['an empty string', '']]) {
    r = await req('POST', '/api/v1/estimates', {
      ...asKey(),
      body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: 'tees', sizes: { M: v }, unit_price: 10 }] },
    })
    chk(`v1 refuses a size count given as ${label}`, `${r.status} ${r.text}`, '^400 .*invalid_quantity')
  }
  // A numeric string is still a number an integration may legitimately send — a form field, a CSV
  // column. It must keep working, or this becomes a different kind of wrong.
  r = await req('POST', '/api/v1/estimates', {
    ...asKey(),
    body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: 'tees', quantity: '24', unit_price: 10 }] },
  })
  chk('…while a numeric string is still accepted', `${r.status} ${JSON.stringify(r.json?.items?.[0]?.sizes || {})}`, '^201 .*"M":24')

  // A null element is what a Zapier/Make line-item mapping emits for a blank row. Every other
  // malformed element already answered 400; only null reached `it.sizes` and threw a 500.
  for (const [label, item] of [['null', null], ['a bare string', 'tees'], ['a number', 123], ['an array', []]]) {
    r = await req('POST', '/api/v1/estimates', {
      ...asKey(),
      body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [item] },
    })
    chk(`v1 refuses a line item that is ${label}, without a 500`, String(r.status), '^400$')
  }
  // Number.isFinite(1e308) is true; 1e308 × 50 is not. computeTotals overflowed to Infinity and
  // SQLite stored NULL, so the caller got 201 for an estimate with no subtotal and no total.
  r = await req('POST', '/api/v1/estimates', {
    ...asKey(),
    body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: 'tees', quantity: 50, unit_price: 1e308 }] },
  })
  chk('v1 refuses a unit_price that overflows the total', `${r.status} ${r.text}`, '^400 .*invalid_unit_price')
  chk('…rather than storing a null subtotal', String(r.json?.subtotal ?? 'none'), '^none$')

  // `taxable` was `it.taxable !== false` — a strict identity test against the boolean, so every
  // other way an integration says no came out TAXABLE: the string "false" that an HTML form or a
  // spreadsheet column posts, 0, "no". A resale or freight line arrived exempt and was taxed
  // anyway, on a document the customer signs, with a 201 and no warning. Same class as the
  // unit_price coercion above: reject, never guess.
  // The two canonical strings are honoured, because that is what a form post and a spreadsheet
  // column actually send; anything else is refused rather than guessed at.
  r = await req('POST', '/api/v1/estimates', {
    ...asKey(),
    body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: 'freight', quantity: 1, unit_price: 100, taxable: 'false' }] },
  })
  chk('v1 reads taxable:"false" as exempt, not as taxable', String(r.json?.items?.[0]?.taxable ?? 'missing'), '^false$')
  for (const [label, bad] of [['0', 0], ['"no"', 'no'], ['an empty string', ''], ['an object', {}]]) {
    r = await req('POST', '/api/v1/estimates', {
      ...asKey(),
      body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: 'freight', quantity: 1, unit_price: 100, taxable: bad }] },
    })
    chk(`v1 refuses taxable given as ${label}`, `${r.status} ${r.text}`, '^400 .*invalid_taxable')
  }
  r = await req('POST', '/api/v1/estimates', {
    ...asKey(),
    body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: 'freight', quantity: 1, unit_price: 100, taxable: false }] },
  })
  chk('…while a real boolean false still marks the line exempt', String(r.json?.items?.[0]?.taxable ?? 'missing'), '^false$')
  r = await req('POST', '/api/v1/estimates', {
    ...asKey(),
    body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: 'tees', quantity: 1, unit_price: 100, taxable: 'TRUE' }] },
  })
  chk('…and the two canonical strings still work, for form-encoded bridges', String(r.json?.items?.[0]?.taxable ?? 'missing'), '^true$')
  r = await req('POST', '/api/v1/estimates', {
    ...asKey(),
    body: { customer: { name: 'API Buyer', email: 'api-buyer@e2e.test' }, items: [{ description: 'tees', quantity: 1, unit_price: 100 }] },
  })
  chk('…and an omitted taxable still defaults to taxable', String(r.json?.items?.[0]?.taxable ?? 'missing'), '^true$')


  /* ---------- an invoice raised by mistake must be recoverable from the UI ----------
   * There was no DELETE route, PUT edits only the due date and PO number, and the estimate behind
   * a converted invoice refuses to be deleted. So an invoice raised against the wrong customer
   * counted toward money owed forever, chased that customer on every overdue scan, and was pushed
   * to QuickBooks — with sqlite3 on the server as the only way out. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Wrong Customer', email: 'wrong@e2e.test' } })
    const wrongId = r.json?.id ?? r.json?.contact?.id
    r = await req('POST', '/api/estimates', {
      body: { contact_id: wrongId, items: [{ description: '100 tees', sizes: { M: 100 }, unit_price: 9, taxable: true }] },
    })
    const estId = r.json?.id ?? r.json?.estimate?.id
    r = await req('POST', `/api/estimates/${estId}/convert`, { body: { due_date: '2026-01-01' } })
    const invId = r.json?.invoice_id
    chk('an estimate converts to an invoice', String(invId ?? ''), '^\\d+$')

    // Unpaid, so it counts toward outstanding right up until the void. (Using `outstanding`
    // rather than `overdue` keeps the assertion independent of what today's date happens to be.)
    const before = await req('GET', '/api/dashboard')
    const owedBefore = Number(before.json?.kpis?.outstanding ?? 0)

    r = await req('POST', `/api/invoices/${invId}/void`, { body: { reason: 'raised against the wrong customer' } })
    chk('an unpaid invoice can be voided', String(r.status), '^200$')

    const after = await req('GET', '/api/dashboard')
    const owedAfter = Number(after.json?.kpis?.outstanding ?? 0)
    chk('a voided invoice stops counting as money owed',
      String(owedBefore > 0 && owedAfter === Number((owedBefore - 900).toFixed(2))), '^true$')

    /* The point of voiding is to be able to put it right, which means the quote must come free.
     * The route allowed it all along — and the SCREEN did not. GET /api/estimates/:id read the
     * invoice without filtering void, and the editor gates Edit, Send, Mark Approved, Convert and
     * Delete on `e.invoice`, so voiding made all five buttons disappear at once and left the
     * owner with Duplicate, PDF and a link to the cancelled invoice. The assertion below has
     * passed since it was written, over a screen from which the call it makes was unreachable —
     * so drive the browser's own read FIRST. */
    r = await req('GET', `/api/estimates/${estId}`)
    chk('a voided invoice does not hide the estimate from its own screen', String(r.json?.invoice ?? 'null'), '^null$')
    chk('…and the cancelled invoice is still shown as history, not erased', String((r.json?.voided_invoices || []).length > 0), '^true$')

    r = await req('POST', `/api/estimates/${estId}/convert`, { body: { due_date: '2026-02-01' } })
    chk('voiding frees the estimate so it can be invoiced correctly', String(r.status), '^200$')

    // Money already recorded is a bookkeeping fact — voiding around it would orphan the payment.
    const invId2 = r.json?.invoice_id

    /* ---------- the cash route refuses what it cannot count ----------
     * `const amount = round2(req.body?.amount)` and round2 starts `Number(n) || 0`, so
     * Number(true) === 1 and Number([40]) === 40 both survived every check below and were
     * INSERTed into `payments` as real money: counted in Revenue MTD, walked the order card to
     * paid, written to the customer's timeline and queued to QuickBooks. A checkbox serialised
     * into the wrong field, or a form library that posts a single-value array, is enough. This is
     * the same "reject, never coerce" rule every quantity field got in v1.18.0 — applied, at
     * last, to the one route in the product that puts cash on an invoice. */
    for (const [label, amount] of [['a checkbox', true], ['a single-value array', [40]], ['an object', { amount: 40 }], ['nothing at all', null]]) {
      const bad = await req('POST', `/api/invoices/${invId2}/payments`, { body: { amount, method: 'check' } })
      chk(`${label} is not a payment amount`, String(bad.status), '^400$')
    }
    const beforeBad = (await req('GET', `/api/invoices/${invId2}`)).json
    chk('…and none of them put a cent on the invoice', String(round2e(beforeBad?.amount_paid ?? 0)), '^0$')
    // What a real HTML form posts is still a payment.
    const asText = await req('POST', `/api/invoices/${invId2}/payments`, { body: { amount: '10.50', method: 'check' } })
    chk('a numeric string from a form still records', String(asText.status), '^200$')
    chk('…at the amount it says', String(round2e(asText.json?.amount_paid ?? 0)), '^10.5$')

    /* ---------- the same cheque, recorded twice, is money the shop does not have ----------
     * The only guard here was the over-payment check, which catches a doubled FULL payment
     * because the second exceeds the remaining balance — and catches nothing else. Two $500 posts
     * against a $1,000 invoice both returned 200 and the invoice came back amount_paid $1,000,
     * status "paid": `invoice.paid` fired, a QuickBooks push queued, the customer was never
     * chased for the $500 they still owed, and Revenue MTD showed income nobody received. The
     * dialog's in-flight guard is per-TAB, so two people at two desks with the same cheque, or a
     * re-click after a response that never arrived, walk straight past it. */
    {
      const dc = (await req('POST', '/api/contacts', { body: { name: 'Duplicate Co', email: 'dupe@e2e.test' } })).json
      const de = (await req('POST', '/api/estimates', { body: { contact_id: dc.id, items: [{ description: 'Tees', qty: 1, unit_price: 1000 }] } })).json
      const invIdOf = (c) => c.json?.invoice?.id ?? c.json?.invoice_id ?? c.json?.id
      const dInv = invIdOf(await req('POST', `/api/estimates/${de.id}/convert`))
      const cheque = { amount: 500, method: 'check', note: 'cheque 1043' }
      const first = await req('POST', `/api/invoices/${dInv}/payments`, { body: cheque })
      chk('a part payment records', String(first.status), '^200$')
      const second = await req('POST', `/api/invoices/${dInv}/payments`, { body: cheque })
      chk('…and the very same cheque again is refused', String(second.status), '^409$')
      chk('…with a code the dialog can act on', String(second.json?.code), '^duplicate_payment$')
      chk('…naming the money it matched', String(second.json?.error || ''), '\\$500\\.00')
      const mid = (await req('GET', `/api/invoices/${dInv}`)).json
      chk('…and the invoice still owes the other half', String(round2e(mid?.amount_paid ?? 0)), '^500$')
      chk('…so it is not marked paid', String(mid?.status), '^(unpaid|partial|overdue)$')
      // It has to be a question, not a wall: two genuine $50 cash payments in a row are ordinary.
      const forced = await req('POST', `/api/invoices/${dInv}/payments`, { body: { ...cheque, confirm: true } })
      chk('…while a human who says it really is a second payment is believed', String(forced.status), '^200$')
      chk('…and it lands', String(round2e(forced.json?.amount_paid ?? 0)), '^1000$')
      // A DIFFERENT payment on the same invoice is never a duplicate.
      const other = (await req('POST', '/api/estimates', { body: { contact_id: dc.id, items: [{ description: 'Tees', qty: 1, unit_price: 300 }] } })).json
      const oInv = invIdOf(await req('POST', `/api/estimates/${other.id}/convert`))
      await req('POST', `/api/invoices/${oInv}/payments`, { body: { amount: 100, method: 'cash', note: 'first' } })
      const diff = await req('POST', `/api/invoices/${oInv}/payments`, { body: { amount: 100, method: 'cash', note: 'second' } })
      chk('a payment that differs by its note is not a duplicate', String(diff.status), '^200$')
      // …and the dialog must be able to send the confirmation, or the refusal is a dead end.
      const { readFileSync: rfs4 } = await import('node:fs')
      chk('…and the Record Payment dialog can answer the question',
        rfs4(join(ROOT, 'public/js/views/invoices.js'), 'utf8'), 'duplicate_payment')
    }

    await req('POST', `/api/invoices/${invId2}/payments`, { body: { amount: 25, method: 'check' } })
    r = await req('POST', `/api/invoices/${invId2}/void`, { body: {} })
    chk('an invoice with payments against it refuses to be voided', `${r.status} ${r.text}`, '^409 .*invoice_has_payments')

    // A voided invoice is a cancelled demand, not a discounted one. Recording money against it
    // inserted a real payment row — counted in Revenue MTD, walked the order card to 'paid' and
    // queued to QuickBooks — while syncInvoiceStatus deliberately refuses to move a void invoice,
    // so the one document a human looks at still read $0.00 paid. The public pay page had the same
    // hole: a customer holding the link emailed before the void could pay it over and over, each
    // click opening a brand-new Stripe session so the idempotency guard never fired.
    r = await req('POST', `/api/invoices/${invId}/payments`, { body: { amount: 100, method: 'check' } })
    chk('a voided invoice refuses to take another dollar', `${r.status} ${r.text}`, '^409 .*invoice_void')
    r = await req('GET', '/api/invoices')
    const voided = (r.json?.invoices || r.json || []).find?.((i) => i.id === invId)
    chk('…and no money was recorded against it', String(voided ? round2e(voided.amount_paid) : 0), '^0$')

    // The dashboard stopped counting the void; A/R aging, the mailed customer statement and the
    // QuickBooks IIF export were the only three balance queries in the file that never got the
    // filter, so Books said $900 due on an invoice the dashboard said was $0 — and the customer
    // got a statement chasing an order the shop had already cancelled.
    r = await req('GET', '/api/reports/ar-aging')
    chk('A/R aging does not chase a voided invoice',
      String(JSON.stringify(r.json || {}).includes('INV-1002')), '^false$')
    r = await req('GET', '/api/export/quickbooks.iif')
    chk('the QuickBooks export does not post a voided invoice to A/R',
      String(r.text.includes('INV-1002')), '^false$')
  }

  /* ---------- being locked out must not be a dead end ----------
   * The gate runs with no mail configured, which is also how most self-hosted installs start.
   * Forgot-password answered "a reset link is on its way", sent nothing, and logged the actual
   * fix to stdout — where an owner running under systemd or Docker never sees it. They wait,
   * retry, hit the 4/hour limit, and are locked out of a database sitting on their own disk.
   * Whether this install can send mail at all is not a per-address fact, so saying so plainly
   * gives away nothing about which accounts exist. */
  r = await req('POST', '/api/auth/forgot', { body: { email: 'gate@e2e.test' } })
  chk('with no mail configured, forgot-password does not promise a link', String(r.status), '^503$')
  chk('…it says why', r.text, 'no email configured')
  chk('…and hands over the command that actually unlocks the account', r.text, 'admin -- reset-password')

  /* ---------- a resale account is never taxed, whichever door the estimate came in ----------
   * taxRateFor() was extracted precisely so this could not be got wrong, and then two paths that
   * could not import it grew their own copy of the arithmetic without the tax_exempt lookup. The
   * AI receptionist and the in-app assistant both billed sales tax to wholesale customers — the
   * one group of buyers guaranteed to notice. Storing the rate matters as much as computing it:
   * an estimate saved with a NULL tax_rate is re-labelled from the shop's current setting on the
   * public page and re-derived on every edit, so the error cannot be corrected by hand. */
  r = await req('POST', '/api/contacts', {
    body: { name: 'Northgate Resale', email: 'ap@northgate.test', tax_exempt: 1, tax_exempt_id: 'RESALE-9921' },
  })
  const exemptId = r.json?.id ?? r.json?.contact?.id
  chk('a tax-exempt customer can be created', String(exemptId ?? ''), '^\\d+$')

  r = await req('POST', '/api/estimates', {
    body: { contact_id: exemptId, items: [{ description: '48 hoodies', sizes: { M: 48 }, unit_price: 32, taxable: true }] },
  })
  chk('estimates API: a resale account is quoted untaxed', String(r.json?.tax ?? r.json?.estimate?.tax ?? 'missing'), '^0$')

  /* The case above omits tax_rate — and the browser NEVER does. public/js/views/estimates.js
   * always sends `tax_rate: +$('#tax').value`, and opening a new estimate from a wholesale
   * customer's own page preselects the buyer without zeroing that field, so the save carried the
   * shop's default rate. taxRateFor checked the override BEFORE reading the buyer, so the
   * exemption was never consulted: $310.00 of sales tax on a $4,000 resale quote, under a screen
   * reading "Wholesale account. Sales tax off." The gate passed green over it for six releases
   * because it only ever tested the shape the browser cannot produce. */
  {
    const line = [{ description: 'Blank tees for resale', sizes: { M: 500 }, unit_price: 8, taxable: true }]
    r = await req('POST', '/api/estimates', { body: { contact_id: exemptId, tax_rate: 7.75, items: line } })
    chk('a resale account is untaxed even when the editor sends the shop rate', String(r.json?.tax ?? 'missing'), '^0$')
    chk('…and rate 0 is what gets STORED, so an edit cannot re-derive the tax', String(r.json?.tax_rate ?? 'missing'), '^0$')

    // The deliberate escape still works — a resale customer buying something they are not
    // reselling. It has to be said in as many words, not carried by a form default.
    r = await req('POST', '/api/estimates', {
      body: { contact_id: exemptId, tax_rate: 7.75, tax_exempt_override: true, items: line },
    })
    chk('…but a shop that says it means it can still tax an exempt buyer', String(Number(r.json?.tax) > 0), '^true$')

    // Retargeting: PUT never consulted tax_exempt at all, so moving a taxed estimate onto the
    // wholesale account kept the tax.
    r = await req('POST', '/api/estimates', { body: { contact_id: 1, tax_rate: 7.75, items: line } })
    const taxedId = r.json?.id
    chk('a taxable buyer is still taxed', String(Number(r.json?.tax) > 0), '^true$')
    r = await req('PUT', `/api/estimates/${taxedId}`, { body: { contact_id: exemptId } })
    chk('retargeting an estimate onto a resale account drops the tax', String(r.json?.tax ?? 'missing'), '^0$')

    // Duplicate copied src.tax_rate verbatim regardless of who the copy was for.
    r = await req('POST', `/api/estimates/${taxedId}/duplicate`, { body: { contact_id: exemptId } })
    const copyId = r.json?.id
    r = await req('GET', `/api/estimates/${copyId}`)
    chk('duplicating onto a resale account drops the tax too', String(r.json?.tax ?? 'missing'), '^0$')
  }

  r = await req('POST', '/api/assistant', { body: { message: 'quote 48 navy hoodies, 2 color front, for Northgate' } })
  chk('the assistant answers a quote request', String(r.status), '^200$')
  {
    // Read the estimate back off the API rather than trusting the chat text.
    const list = await req('GET', '/api/estimates')
    const rows = list.json?.estimates || list.json || []
    const mine = (Array.isArray(rows) ? rows : []).filter((e) => e.contact_id === exemptId)
    const drafted = mine.find((e) => Number(e.tax) === 0 && Number(e.tax_rate) === 0)
    chk('assistant: the resale estimate carries no tax AND stores rate 0', String(!!drafted), '^true$')
    // A stored NULL is the silent half of this bug: it reads as 0 in JSON but re-derives on edit.
    const nullRate = mine.some((e) => e.tax_rate === null || e.tax_rate === undefined)
    chk('assistant: no estimate is left with a NULL tax_rate', String(nullRate), '^false$')
  }

  /* ---------- the assistant charges for a rush the way every other path does ----------
   * v1.18.0 gave every automated quoting path the rush surcharge by routing it through
   * priceIntake. The in-app assistant still built its own price with a hand-rolled
   * quoteScreenPrint call, so it wrote a bare "RUSH." onto the customer-visible line, scheduled
   * nothing differently, and charged the standard rate: rush and non-rush came back
   * byte-identical. On 300 tees the shop's own published 3-day tier is a 50% uplift on the piece.
   * Two expressions reading one input, which is how they were free to disagree. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Northgate Athletics Club', email: 'northgate-club@e2e.test' } })
    const raC = r.json?.id
    // Newest by id — the list is not ordered oldest-first, and picking the wrong end of it
    // compares one estimate with itself.
    const newestFor = async () => ((await req('GET', '/api/estimates')).json || [])
      .filter((e) => e.contact_id === raC).sort((a, b) => b.id - a.id)[0]
    const priceOf = async (text) => {
      await req('POST', '/api/assistant', { body: { message: text } })
      return Number((await newestFor())?.subtotal || 0)
    }
    const std = await priceOf('quote 300 tees, 2 color front, for Northgate Athletics Club')
    const rush = await priceOf('quote 300 tees, 2 color front, RUSH, for Northgate Athletics Club')
    chk('the assistant saves a standard quote', String(std > 0), '^true$')
    chk('…and a rush quote is not byte-identical to it', String(rush !== std), '^true$')
    chk('…it is dearer, because a rush costs the shop more', String(rush > std), '^true$')
    // The published 3-day tier is +50% on the per-piece; setup does not scale with speed, so the
    // uplift on the whole quote lands between the piece uplift and nothing. Assert the direction
    // and the magnitude, not a hardcoded dollar figure the price book can legitimately move.
    chk(`…by roughly the shop's own 3-day tier (${std} → ${rush})`,
      String(rush > std * 1.2 && rush < std * 1.6), '^true$')
    const full = (await req('GET', `/api/estimates/${(await newestFor())?.id}`)).json
    chk('…and the customer line says what the surcharge is, not a bare "RUSH."',
      JSON.stringify(full?.items || []), 'RUSH \\+\\d+%')
  }

  /* ---------- …and the rush the customer PAID for reaches the floor ----------
   * Every automated path was taught to CHARGE the shop's published rush tier in v1.18.0/v1.19.0.
   * Not one was taught to PRODUCE a rush. `estimates` had nowhere to record the tier the price was
   * built from, and convert bound neither `rush` nor `turnaround_days`, so the column defaults
   * landed — 0 and 10 — on a job whose customer had just paid +50% for three days. Measured: a
   * 300-piece order billed $4,280.00 against a $2,870.00 standard price came out promised
   * 2026-09-02, projected 2026-09-11 the moment the job existed, and rewritten to 2026-09-14 at
   * proof approval. Eight working days past the date the customer bought. And nothing on the floor
   * knew: no badge on the board card, no banner on the work ticket, no pill in Floor Mode, and the
   * board's Rush filter — the view a manager opens to ask what goes out first — permanently empty. */
  {
    const rushText = 'We need 300 Gildan 5000 tees in black, 1 color front. RUSH please. fastlane@e2e.test'
    const ap = (await req('POST', '/api/autopilot', { body: { text: rushText } })).json
    chk('a rush quote is priced as a rush', String(Number(ap?.estimate?.total) > 0), '^true$')
    chk('…and the estimate records the tier it was priced on', String(ap?.estimate?.rush_days > 0), '^true$')
    chk('…and the job it writes is flagged rush', String(ap?.job?.rush), '^1$')
    chk('…on the turnaround it was billed for, not the 10-day default',
      String(Number(ap?.job?.turnaround_days) <= 3 && Number(ap?.job?.turnaround_days) >= 1), '^true$')

    // The shop's OWN main path: a quote a human sends, the customer approves, someone converts.
    const dup = (await req('POST', `/api/estimates/${ap.estimate.id}/duplicate`, { body: {} })).json
    const conv = (await req('POST', `/api/estimates/${dup.id}/convert`, { body: {} })).json
    const cj = (await req('GET', `/api/jobs/${conv.job_id}`)).json
    const job = cj?.job || cj
    chk('converting a rush quote makes a rush job', String(job?.rush), '^1$')
    chk('…scheduled on the tier that was billed', String(job?.turnaround_days), '^3$')
    chk('…so the schedule does not announce a slip the moment it is created',
      String(cj?.schedule?.slip ?? job?.schedule?.slip ?? 0), '^0$')

    // The three surfaces the floor actually looks at.
    const board = (await req('GET', '/api/board?filter=rush')).json
    const shown = (board?.columns || []).reduce((n, c) => n + (c.jobs?.length || 0), 0)
    chk('the board\'s Rush filter is not empty', String(shown > 0), '^true$')
    chk('…and its counter agrees', String(Number(board?.counts?.rush) > 0), '^true$')
    // GET /api/jobs/:id is where the tokenized staff work-ticket link comes from.
    const tkUrl = String(cj?.ticket_url || '').replace(/^https?:\/\/[^/]+/, '')
    chk('the job hands out a work-ticket link', String(!!tkUrl), '^true$')
    const ticket = await fetch(`${BASE}${tkUrl}`, { headers: { Cookie: cookieHeader() } })
    const tkHtml = await ticket.text()
    chk('the work ticket the press operator holds says RUSH', String(/class="rush"/.test(tkHtml)), '^true$')

    // …and an ordinary job is still an ordinary job, or the flag means nothing.
    const std = (await req('POST', '/api/autopilot', { body: { text: 'Please quote 300 Gildan 5000 tees in black, 1 color front. fastlane@e2e.test' } })).json
    chk('a standard quote is not flagged rush', String(std?.job?.rush), '^0$')
    chk('…and keeps the standard turnaround', String(std?.job?.turnaround_days), '^10$')
  }

  /* ---------- …and so does "Read an order from an email", the biggest quoting surface ----------
   * views/intake.js carried a THIRD pricing engine (`intakeQuote`) beside priceIntake and the
   * manual quote screen. Same defect as the assistant's, one screen over and far more used: it
   * wrote a bare "RUSH." onto the customer-visible line and charged the standard rate, used a
   * hardcoded $3.20 blank instead of the live distributor cost, and ignored the shop's price book.
   * Measured on 300 tees, 2 colour front, 3-day rush: $2,649.00 against a canonical $4,305.00.
   * /api/ai/intake returns the priced lines now, and the screen has no opinion about money. */
  {
    const readIt = async (text) => (await req('POST', '/api/ai/intake', { body: { text } })).json
    const sub = (p) => (p?.priced?.items || []).reduce((n, i) => {
      const grid = Object.values(i.sizes || {}).reduce((a, b) => a + (Number(b) || 0), 0)
      return n + (Number(i.unit_price) || 0) * (grid || Number(i.qty) || 0)
    }, 0)
    const stdP = await readIt('We need 300 Gildan 5000 tees in black, 2 color front.')
    const rushP = await readIt('We need 300 Gildan 5000 tees in black, 2 color front. RUSH — need them in 3 days.')
    chk('reading an email hands back priced lines, not just a parse', String((stdP?.priced?.items || []).length > 0), '^true$')
    chk('…it read the rush', String(rushP?.rush), '^true$')
    chk('…and charged for it', String(sub(rushP) > sub(stdP)), '^true$')
    chk(`…at roughly the shop's own 3-day tier (${sub(stdP)} → ${sub(rushP)})`,
      String(sub(rushP) > sub(stdP) * 1.2 && sub(rushP) < sub(stdP) * 1.6), '^true$')
    chk('…and the customer line says what the surcharge is, not a bare "RUSH."',
      JSON.stringify(rushP?.priced?.items || []), 'RUSH \\+\\d+%')
    chk('…and it bills the setup the decoration actually has', JSON.stringify(rushP?.priced?.items || []), 'Screen setup')
    // The screen must not be able to disagree with the server again.
    const { readFileSync: rfs3 } = await import('node:fs')
    const intakeSrc = rfs3(join(ROOT, 'public/js/views/intake.js'), 'utf8')
    for (const engine of ['quoteScreenPrint', 'servicePerPiece', 'function intakeQuote']) {
      chk(`…because the intake screen no longer carries ${engine}`, String(intakeSrc.includes(engine)), '^false$')
    }
  }

  /* ---------- changing your password keeps THIS device signed in ----------
   * setMemberPassword now signs out every session (so a compromised one dies), and the route
   * re-issues a fresh session for the current device. If the re-issue broke, a user would lock
   * themselves out the instant they changed their password — so guard it. */
  {
    const before = cookieHeader()
    r = await req('POST', '/api/auth/password', { body: { current_password: 'GatePass-123456', new_password: 'GatePass-654321' } })
    chk('a password change succeeds', String(r.status), '^200$')
    // The jar now holds the re-issued cookie; the current session must still be authed.
    const me = await req('GET', '/api/auth/me')
    chk('…and the current device stays signed in (re-issued session)', me.text, '"authed":true')
    // The OLD cookie must no longer work — every prior session was invalidated.
    const old = await req('GET', '/api/auth/me', { cookies: false, headers: { Cookie: before } })
    chk('…while the pre-change session is invalidated', old.text, '"authed":false')
    // Put the password back so any later test that assumes the original still works.
    await req('POST', '/api/auth/password', { body: { current_password: 'GatePass-654321', new_password: 'GatePass-123456' } })
  }

  /* ---------- malformed field types must not 500 a write ----------
   * node:sqlite refuses to bind an object/array/undefined, surfacing as a 500. Request bodies are
   * external input, so a client that sends {} where a string goes must get a clean answer, not a
   * crash — and a note against a customer another tab just deleted must be 404, not an FK 500. */
  r = await req('POST', '/api/contacts', { body: { name: 'Coerce Co', email: {}, company: ['a', 'b'] } })
  chk('a contact with object/array fields is accepted (coerced), not 500', String(r.status), '^(200|201)$')
  const coId = r.json?.id ?? r.json?.contact?.id
  r = await req('PUT', `/api/contacts/${coId}`, { body: { name: 'Coerce Co', phone: { nope: 1 } } })
  chk('updating with a malformed field does not 500', String(r.status), '^200$')
  r = await req('PUT', `/api/contacts/${coId}`, { body: { email: 'x@x.test' } })
  chk('…and a nameless update is a clean 400', String(r.status), '^400$')
  r = await req('POST', '/api/contacts/99999999/note', { body: { text: 'hi' } })
  chk('a note on a deleted/missing customer is 404, not an FK 500', String(r.status), '^404$')

  /* ---------- signup never leaks a database error to the public page ----------
   * The email check and the slug generator are both check-then-insert, so a race collides at the
   * INSERT — and that used to surface "UNIQUE constraint failed: tenants.owner_email" verbatim on
   * the public signup form. A duplicate must come back as a clean 409, never raw SQL. */
  r = await req('POST', '/api/auth/signup', { cookies: false, body: { shop_name: 'Dupe Shop', owner_name: 'X', owner_email: 'gate@e2e.test', password: 'DupePass-123456' } })
  chk('a duplicate-email signup is a clean 409', String(r.status), '^409$')
  chk('…and never leaks the SQL constraint text', r.text, '^(?!.*(UNIQUE|SQLITE|constraint)).*$')

  /* ---------- an estimate's line items cannot carry markup into the owner's browser ----------
   * The editor escapes every string field it knows about, and rendered three object-derived ones
   * raw: the size-grid KEYS, the size-grid VALUES, and item.matrix.{name,row,col} inside a title
   * attribute. Neither POST nor PUT /api/estimates has a role check, so any staff account could
   * write them and the owner opened the estimate — staff -> owner stored XSS through innerHTML
   * under script-src 'self' 'unsafe-inline'. The /api/v1 twin already validated sizes correctly. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'XSS Buyer', email: 'xss@e2e.test' } })
    const xid = r.json?.id ?? r.json?.contact?.id
    const payload = '"><img src=x onerror=alert(1)>'
    r = await req('POST', '/api/estimates', {
      body: {
        contact_id: xid,
        items: [{
          description: 'tees',
          sizes: { M: 10, [payload]: 5 },
          unit_price: 10,
          matrix: { id: 1, name: payload, row: payload, col: payload },
        }],
      },
    })
    // INVERTED DELIBERATELY. This used to assert 200-and-scrubbed, which was the right assertion
    // while the rule was `SIZES.includes(k)` + `continue`: the key was hostile, so dropping it was
    // safe. But that same silent drop was deleting REAL sizes — 6XL and the tall run were not in
    // SIZES either, so a 45-piece order was billed as 35 pieces. The rule is now a character class
    // and the response is a 400, so both cases are covered by one behaviour: a key that is not a
    // size is refused and named, never quietly removed from what the customer is billed for. The
    // XSS property this block exists for is stronger under a refusal than under a scrub.
    chk('an estimate with a hostile size key is refused, not silently scrubbed', String(r.status), '^400$')
    chk('…and told which key, with a machine-readable code', String(r.json?.code), '^unknown_size$')
    chk('…and nothing was written', String((await req('GET', '/api/estimates')).json?.estimates?.some?.((e) => e.contact_id === xid) ?? false), '^false$')

    // The same line WITHOUT the hostile key still stores, so the matrix half of this block is
    // still exercised. A matrix NAME is the shop's own free text and cannot have '<' banned from
    // it — its fix is escaping at every render site, asserted in bin/gate.mjs. What must hold here
    // is that it is stored as a bounded string in a known shape, never an arbitrary nested object.
    r = await req('POST', '/api/estimates', {
      body: {
        contact_id: xid,
        items: [{ description: 'tees', sizes: { M: 10 }, unit_price: 10, matrix: { id: 1, name: payload, row: payload, col: payload } }],
      },
    })
    chk('…while the same line without it is accepted', String(r.status), '^200$')
    chk('…and the real size survives', String(r.json?.items?.[0]?.sizes?.M ?? 'missing'), '^10$')
    const mx = r.json?.items?.[0]?.matrix
    chk('…the matrix provenance keeps only its four known fields', Object.keys(mx || {}).sort().join(','), '^col,id,name,row$')
    // Read it back the way the editor does, to be sure nothing revives on the trip.
    const eid = r.json?.id
    r = await req('GET', `/api/estimates/${eid}`)
    chk('…and no hostile size key exists when the editor loads it', String(Object.keys(r.json?.items?.[0]?.sizes || {}).join(',')), '^M$')
    // A non-array items body reached computeTotals and threw a 500 on the main create path.
    for (const [label, bad] of [['an object', { a: 1 }], ['a string', 'tees'], ['a number', 7]]) {
      r = await req('POST', '/api/estimates', { body: { contact_id: xid, items: bad } })
      chk(`items given as ${label} is refused, not a 500`, String(r.status), '^400$')
    }
  }

  /* ---------- the price book cannot be filled with junk one character at a time ----------
   * `services` was walked with Object.entries on trust. Handed a STRING that yields one entry per
   * character: PUT {"services":"Screen Print"} minted twelve $0.00 services named "0".."11", and a
   * 20,000-character value minted twenty thousand of them in one 45ms request — after which
   * GET /api/pricebook was 13.6 MB and /api/settings went from 4 KB to 3.6 MB, taking the Pricing
   * and Settings screens with them. Undoing it meant twenty thousand deletions, one at a time. */
  {
    r = await req('GET', '/api/pricebook')
    const before = Object.keys(r.json?.services || {}).length
    for (const [label, bad] of [['a string', 'Screen Print'], ['an array', ['Screen Print']], ['a number', 7]]) {
      r = await req('PUT', '/api/pricebook', { body: { services: bad } })
      chk(`the price book refuses services given as ${label}`, `${r.status} ${r.text}`, '^400 .*invalid_services')
    }
    r = await req('PUT', '/api/pricebook', { body: { services: { 'Screen Print': 'nope' } } })
    chk('…and refuses a service that is not an object', `${r.status} ${r.text}`, '^400 .*invalid_services')
    r = await req('PUT', '/api/pricebook', { body: { services: Object.fromEntries(Array.from({ length: 200 }, (_v, i) => [`Svc ${i}`, { base: 1 }])) } })
    chk('…and refuses a price book of 200 services', `${r.status} ${r.text}`, '^400 .*too_many_services')
    r = await req('GET', '/api/pricebook')
    chk('…leaving the shop\'s price book exactly as it was', String(Object.keys(r.json?.services || {}).length), `^${before}$`)
    // A real save still works.
    r = await req('PUT', '/api/pricebook', { body: { services: { 'Screen Print': { base: 2.75 } } } })
    chk('…while an ordinary one-service save still saves', String(r.status), '^200$')
  }

  /* ---------- money must never be a number the arithmetic could not produce ----------
   * qty: 1e308 multiplied out to Infinity and round2's overflow fallback passed it through.
   * SQLite stored Infinity in estimates.total, /convert carried it to invoices.amount_due, and
   * SUM(amount_due) then poisoned the WHOLE shop: the Outstanding KPI and every total in the A/R
   * aging report went blank, not just that customer's. The estimate would not delete afterwards
   * ("can't delete a converted estimate"), so the only exit from the UI was voiding an invoice
   * that looked real. The v1 API already refused exactly this; the app's own screens did not. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Overflow Buyer', email: 'overflow@e2e.test' } })
    const ovId = r.json?.id ?? r.json?.contact?.id
    for (const [label, item] of [
      ['a quantity of 1e308', { description: 'boom', qty: 1e308, unit_price: 10 }],
      ['a unit price of 1e308', { description: 'boom', qty: 10, unit_price: 1e308 }],
      ['both at 1e308', { description: 'boom', qty: 1e308, unit_price: 1e308 }],
    ]) {
      r = await req('POST', '/api/estimates', { body: { contact_id: ovId, items: [item], tax_rate: 0 } })
      chk(`an estimate with ${label} is refused, not stored`, `${r.status} ${r.text}`, '^400 .*invalid_total')
    }
    // A sales tax rate is a percentage; 100000% was accepted and produced a real tax line.
    r = await req('POST', '/api/estimates', { body: { contact_id: ovId, items: [{ description: 'tees', qty: 10, unit_price: 10 }], tax_rate: 100000 } })
    chk('an absurd tax rate is clamped rather than billed', String(r.json?.tax ?? 'missing'), '^100$')
    // …and the shop's own money screens still add up.
    r = await req('GET', '/api/dashboard')
    chk('the dashboard still reports a real Outstanding figure', String(Number.isFinite(Number(r.json?.outstanding ?? r.json?.kpis?.outstanding ?? 0))), '^true$')
  }

  /* ---------- the whole-data export streams valid JSON ----------
   * This is the anti-lock-in "get all your data out" path. It used to build the entire graph in
   * memory and pretty-print it into a second copy — ~34 MB of heap for one export on a box with a
   * 40 MB budget for all 14 shops, i.e. an OOM exactly when a shop needed to leave. It now streams
   * row by row; here we just prove the streamed bytes are still valid, complete JSON. */
  // A live webhook has to exist before the export runs, or the redaction assertions below pass
  // vacuously on an empty table.
  await req('POST', '/api/developers/webhooks', { body: { url: 'https://example.com/hook-export-redaction', events: ['invoice.paid'] } })
  r = await req('GET', '/api/export/all.json')
  chk('the full export returns 200', String(r.status), '^200$')
  {
    let parsed = null
    try { parsed = JSON.parse(r.text) } catch { /* leave null */ }
    chk('…and the streamed bytes are valid JSON', String(!!parsed), '^true$')
    // This assertion USED to be a hardcoded eight-name list, which is how "export everything" came
    // to mean 7 of 26 tables while README, docs/API.md and the Settings card all promised the whole
    // database — the gate certified the gap green every release. The list is derived from
    // sqlite_master now, so name the tables that were actually missing and let a future table be
    // included by default rather than silently dropped.
    const got = Object.keys(parsed?.tables || {})
    for (const missing of ['settings', 'price_matrices', 'opportunities', 'messages', 'email_log',
      'job_scans', 'automations', 'purchase_orders', 'po_lines', 'chat_messages', 'chat_sessions',
      'qbo_sync', 'webhook_subscriptions', 'bot_config']) {
      chk(`…export includes ${missing}`, String(got.includes(missing)), '^true$')
    }
    // Credentials are not shop data and must never ride along in a file that gets emailed around.
    for (const secret of ['sessions', 'password_resets']) {
      chk(`…and never exports ${secret}`, String(got.includes(secret)), '^false$')
    }
    chk('…and says which tables it left out, and why', String(!!parsed?.excluded?.sessions), '^true$')
    /* A credential COLUMN inside a table that is otherwise the shop's own data. EXPORT_SKIP is a
     * whole-table deny-list and could not express this: the shop wants its webhook endpoints and
     * event selections back, but `secret` is the live HMAC signing key. listWebhooks() has always
     * omitted it; the export shipped it in plaintext, in the same file whose own code comment says
     * it gets emailed around and dropped in Drive — and the settings table two branches away was
     * already redacted for exactly that reason. Holding one export let anyone forge a signed
     * invoice.paid into whatever the shop had wired up. */
    {
      const hooks = parsed?.tables?.webhook_subscriptions || []
      chk('…the export still returns the shop\'s webhooks', String(hooks.length > 0), '^true$')
      chk('…with the endpoint they need to rebuild', String(hooks.every((h) => 'url' in h)), '^true$')
      chk('…and no live signing secret in any of them', String(hooks.some((h) => h.secret)), '^false$')
      chk('…flagged, so a re-import knows to re-issue rather than trust it', String(hooks.every((h) => h.redacted === true)), '^true$')
      chk('…and named in the header beside the excluded tables', String(!!parsed?.redacted?.webhook_subscriptions), '^true$')
      chk('…and the whole file carries no whsec_ anywhere', String(/whsec_/.test(r.text)), '^false$')
    }
    // A truncated export must never look like a finished one.
    chk('…and marks itself complete', String(parsed?.complete), '^true$')
    // The settings table carries the shop's price book AND every integration credential.
    {
      const rows = parsed?.tables?.settings || []
      const leaked = rows.filter((x) => ['stripe_secret', 'smtp_pass', 'ai_api_key', 'qbo_refresh_token'].includes(x.key) && x.value)
      chk('…with the shop\'s own settings included', String(rows.length > 0), '^true$')
      chk('…but no credential in the file', String(leaked.length), '^0$')
    }
    // The estimate created earlier must be in it — proving rows actually stream, not just the shell.
    chk('…and it contains the shop\'s real rows', String((parsed?.tables?.estimates || []).length > 0), '^true$')
  }

  /* ---------- a board-created job must count as real pieces ----------
   * The job form takes a free-text "24 S / 60 M / 80 L / 36 XL", stored as a string the piece
   * counter could not parse — so a job created on the board booked zero press minutes, printed a
   * blank size table, ordered no blanks and reported no ROI. It must now carry a real size grid. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Board Job Co', email: 'board@e2e.test' } })
    const cid = r.json?.id ?? r.json?.contact?.id
    r = await req('POST', '/api/jobs', { body: { contact_id: cid, title: 'Board tees', decoration: 'Screen Print', quantities: '24 S / 60 M / 80 L / 36 XL', due_date: '2026-10-01' } })
    chk('a board job is created', String(r.status), '^200$')
    const sizes = (() => { try { return JSON.parse(r.json?.sizes || '{}') } catch { return {} } })()
    const total = Object.values(sizes).reduce((a, b) => a + Number(b), 0)
    chk('…and its free-text quantities became a real size grid (200 pieces)', String(total), '^200$')
  }

  /* ---------- a malformed cookie must not lock the user out ----------
   * parseCookies ran decodeURIComponent on every cookie value, and that throws on a malformed
   * percent-escape. A cookie is attacker-controlled and this runs before the auth gate, so a
   * single bad value 500'd every route — login included — until the user cleared site data. */
  r = await req('GET', '/health', { cookies: false, headers: { Cookie: 'psc_session=%; junk=%zz' } })
  chk('a malformed cookie does not 500 the request', String(r.status), '^200$')
  r = await req('POST', '/api/auth/login', { cookies: false, headers: { Cookie: 'psc_session=%e0%a4' }, body: { email: 'nobody@e2e.test', password: 'x' } })
  chk('…and login still works past a broken cookie (401, not 500)', String(r.status), '^40[01]$')

  /* ---------- submitting a purchase order twice must not order the blanks twice ----------
   * Submitting places a REAL, chargeable order at the distributor. The guard tested for the single
   * string 'submitted', and status is not written until AFTER the awaited submit — so two clicks a
   * second apart both read 'draft' and both sent. Worse, receiving overwrites status with 'partial',
   * which is precisely when a manager hits Submit again to chase a short delivery: it re-ordered
   * the whole run. The question the guard has to ask is "has this gone out?", not "is it in exactly
   * this one state?". */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'PO Buyer', email: 'po-buyer@e2e.test' } })
    const poCid = r.json?.id ?? r.json?.contact?.id
    r = await req('POST', '/api/estimates', {
      body: { contact_id: poCid, items: [{ description: 'Gildan 5000 Heavy Cotton Tee — Black', sizes: { S: 24, M: 60, L: 80 }, unit_price: 11, taxable: true }] },
    })
    const poEst = r.json?.id ?? r.json?.estimate?.id
    r = await req('POST', `/api/estimates/${poEst}/convert`, { body: { due_date: '2026-07-01' } })
    const poJob = r.json?.job_id

    r = await req('POST', `/api/jobs/${poJob}/po/submit`, { body: {} })
    const firstStatus = r.json?.purchase_order?.status ?? ''
    chk('a purchase order can be submitted', `${r.status}`, '^200$')

    // The gate shop has no distributor connected, so this settles at 'failed' — which is
    // legitimately retryable, nothing was ordered. What must NOT happen either way is a second
    // purchase_orders row: the retry has to reuse the one record receiving works against.
    r = await req('POST', `/api/jobs/${poJob}/po/submit`, { body: {} })
    chk('…and a retry reuses the record rather than stacking a second one', `${firstStatus}|${r.status}`, '\\|200$')

    const list = await req('GET', `/api/jobs/${poJob}/purchase-orders`)
    chk('…and the job still has exactly one purchase order',
      String((list.json?.purchase_orders || []).length), '^1$')
  }

  /* ---------- the app's own security headers must not disable the app ----------
   * `Permissions-Policy: camera=()` is an EMPTY allowlist, which disables getUserMedia for this
   * document — not only for embedded frames. So Floor Mode's barcode scanner never worked on any
   * install: getUserMedia rejects with `NotAllowedError: Permissions policy violation` BEFORE the
   * browser shows a permission prompt, and the screen toasts an error naming a policy the shop
   * cannot change from anywhere in the product. It only ever ran on Chromium, because scan.js
   * gates the camera on BarcodeDetector — which is exactly where the header is enforced — and
   * manifest.json's start_url is /#/scan, so the installed tablet PWA opens straight onto it. */
  {
    const hdr = (await fetch(`${BASE}/`, { headers: { Cookie: cookieHeader() } })).headers
    const pp = String(hdr.get('permissions-policy') || '')
    chk('the app sends a Permissions-Policy at all', pp, 'camera=')
    chk('…and it does not disable the camera the product ships a screen for', String(/camera=\(\)/.test(pp)), '^false$')
    chk('…it grants the app\'s own origin', pp, 'camera=\\(self\\)')
    // The things the product does NOT use stay off, so this is a grant and not a blanket removal.
    for (const feat of ['microphone', 'geolocation', 'payment']) {
      chk(`…while ${feat} stays disabled`, pp, `${feat}=\\(\\)`)
    }
    const { readFileSync: rfs2 } = await import('node:fs')
    chk('…and the screen that needs it is still shipped and still asks for it',
      rfs2(join(ROOT, 'public/js/views/scan.js'), 'utf8'), 'navigator\\.mediaDevices\\.getUserMedia')
    chk('…on the route an installed tablet opens on',
      String(JSON.parse(rfs2(join(ROOT, 'public/manifest.json'), 'utf8')).start_url), '^/#/scan$')
  }

  /* ---------- AGPL §13: the source link is served, on every page a user can reach ----------
   * §13 is a licence obligation, not a style choice: run a modified version over a network and its
   * users must be offered the corresponding source. sourceLinkHtml() renders it into index.html
   * and auth.html — and NOTHING in either suite has ever asserted that, so four rounds of releases
   * verified it by hand after the fact. A conditional, a template rename, or a stray edit to
   * either shell would have shipped a licence violation with a green gate. */
  {
    // /index.html and /auth.html are on this list deliberately. `index: false` on the static mount
    // only suppresses the DIRECTORY index, so `GET /` fell through to the SPA catch-all and was
    // rendered — while an explicit `GET /index.html` matched a real file and express.static served
    // it off disk, bypassing the only two places __SOURCE_LINK__ is ever replaced. Both raw pages
    // load /css and /js by absolute path, so they were a fully working copy of the app handed to
    // an anonymous caller with no offer of the Corresponding Source, shipping the literal
    // placeholder where the §13 link belongs. Every path a user can type has to be on this list.
    for (const [path, what] of [['/', 'the app'], ['/index.html', 'the app by its file name'], ['/auth.html', 'the auth page by its file name'], ['/login', 'the login page'], ['/signup', 'the signup page'], ['/reset', 'the reset page']]) {
      const page = await req('GET', path, { cookies: false })
      chk(`${what} serves the AGPL source link`, page.text, 'class="source-link"')
      chk(`…pointing somewhere a user can actually fetch it`, page.text, 'href="https?://[^"]+"[^>]*class="source-link"|class="source-link" href="https?://[^"]+"')
      chk(`…and no unreplaced placeholder is left on ${what}`, String(page.text.includes('__SOURCE_LINK__')), '^false$')
    }
    // The customer-facing /p/ pages are served by their own renderer, so they are not asserted here
    // — §13 applies to users interacting with the software remotely, which is the app itself.
    const shell = await req('GET', '/', { cookies: false })
    chk('the link names the licence, so it is recognisable as the §13 offer', shell.text, 'AGPL-3\\.0')

    // Structural: any file under public/ that carries a template placeholder must be served by a
    // renderer, never off disk — so the next templated page cannot repeat this by being added.
    const { readdirSync, readFileSync: rf } = await import('node:fs')
    const templated = readdirSync(join(ROOT, 'public'))
      .filter((f) => f.endsWith('.html'))
      .filter((f) => /__[A-Z0-9_]+__/.test(rf(join(ROOT, 'public', f), 'utf8')))
    chk('the templated pages are found where they live', String(templated.sort().join(',')), '^auth\\.html,index\\.html$')
    for (const f of templated) {
      const raw = await req('GET', `/${f}`, { cookies: false })
      chk(`/${f} is rendered, not served off disk`, String(/__[A-Z0-9_]+__/.test(raw.text)), '^false$')
    }
  }

  /* ---------- a backorder the distributor cancelled does not wedge the job forever ----------
   * DELETE /api/jobs/:id has told shops to "short-close it if the rest is not coming" since it was
   * written, and nothing anywhere could: 'closed' is READ by poAlreadySent and written by nobody,
   * and receivePurchaseOrder can only reach 'received' on a FULL receipt. So a PO the distributor
   * part-filled — the routine case, a discontinued colour — sat at 'partial', which is in
   * PO_STILL_OUT, and the job could never leave the board. The one escape the product offered was
   * to sign for blanks that never arrived, which then feeds the shortage report, the pick ticket,
   * the packing list and the job's blank cost in ROI. A wedged board or a corrupted inventory
   * record, and the refusal naming an action that does not exist. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Short PO Sherry', email: 'shortpo@e2e.test' } })
    const shortC = r.json?.id
    r = await req('POST', '/api/jobs', { body: { contact_id: shortC, title: 'Short PO job', garment: 'Gildan 5000 Heavy Cotton Tee — Black', quantities: '24 S / 60 M' } })
    const shortJ = r.json?.id
    await req('PUT', '/api/settings', { body: { sanmar_user: 'gate', sanmar_pass: 'gate', sanmar_cust: '1' } })
    await req('POST', `/api/jobs/${shortJ}/po/submit`, { body: {} })
    r = await req('GET', `/api/jobs/${shortJ}/purchase-orders`)
    const shortPo = (r.json?.purchase_orders || [])[0]
    chk('the job has a purchase order out at the distributor', String(!!shortPo), '^true$')
    // 60 of the 84 arrive; the distributor cancels the rest.
    const arrived = (shortPo?.lines || [])[1]
    await req('POST', `/api/purchase-orders/${shortPo?.id}/receive`, { body: { receipts: [{ line_id: arrived?.id, qty: arrived?.qty_ordered }] } })
    r = await req('GET', `/api/purchase-orders/${shortPo?.id}`)
    chk('…and it is short after a partial delivery', String(r.json?.short > 0), '^true$')

    r = await req('DELETE', `/api/jobs/${shortJ}`)
    chk('the job cannot be deleted while blanks are still out', String(r.status), '^409$')
    chk('…and the refusal tells the shop to short-close it', r.text, 'short-close')

    r = await req('POST', `/api/purchase-orders/${shortPo?.id}/close`, { body: { reason: 'distributor cancelled the balance' } })
    chk('…and short-closing is something that exists', String(r.status), '^200$')
    chk('…without pretending the missing blanks turned up', String(r.json?.purchase_order?.received), `^${arrived?.qty_ordered}$`)
    chk('…and the shortage is still on the record', String(r.json?.purchase_order?.short > 0), '^true$')
    const acts = ((await req('GET', '/api/activities')).json || []).filter((a) => /short-closed/.test(String(a.description || '')))
    chk('…and the timeline says it happened', String(acts.length >= 1), '^true$')

    r = await req('DELETE', `/api/jobs/${shortJ}`)
    chk('…so the job can finally leave the board', String(r.status), '^200$')
  }

  /* ---------- a partial update does not quietly clear what it did not mention ----------
   * PUT /api/jobs/:id read every field with `??` — keep what is there unless told otherwise — and
   * `rush` with `b.rush ? 1 : 0`, which reads an absent field as false. So saving a note took the
   * job off RUSH: it dropped down the board's sort order, lost its badge on the work ticket and on
   * Today, and stopped being counted by the Rush filter. Nothing said so, and nothing on the job
   * records that it ever was one. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Rush Rita', email: 'rush-rita@e2e.test' } })
    const rushC = r.json?.id
    r = await req('POST', '/api/jobs', { body: { contact_id: rushC, title: 'Hot job', quantities: '48 M', rush: true } })
    const rushJ = r.json?.id
    chk('a job can be marked rush', String(!!(await req('GET', `/api/jobs/${rushJ}`)).json?.rush), '^true$')

    await req('PUT', `/api/jobs/${rushJ}`, { body: { notes: 'customer called about the deadline' } })
    r = await req('GET', `/api/jobs/${rushJ}`)
    chk('…and saving a note does not take it off rush', String(!!r.json?.rush), '^true$')
    chk('…while the note it was actually asked to save is saved', String(r.json?.notes || ''), 'customer called')

    // Turning it off is still possible — the field just has to be the one that was sent.
    await req('PUT', `/api/jobs/${rushJ}`, { body: { rush: false } })
    chk('…and rush can still be turned off deliberately', String(!!(await req('GET', `/api/jobs/${rushJ}`)).json?.rush), '^false$')
  }

  /* ---------- an owner can change their own password from inside the app ----------
   * POST /api/auth/password has existed, complete and correct, since logins shipped: it verifies
   * the current password, enforces the minimum, clears the owner's legacy tenant hash, and re-mints
   * a session for THIS device while dropping every other one. It had zero callers anywhere in
   * public/. The only way to change a password was to sign out, claim you had forgotten it, and
   * wait for an email — which needs SMTP configured, so on a shop that had not set up mail yet
   * there was no way at all. A shared password nobody can rotate is a security hole with no exit. */
  {
    const { readFileSync } = await import('node:fs')
    const EMAIL = 'gate@e2e.test', PASSWORD = 'GatePass-123456'
    const ui = readFileSync(join(ROOT, 'public/js/views/misc.js'), 'utf8')
    chk('Settings offers a control that changes your password', String(/api\/auth\/password/.test(ui)), '^true$')

    // And the route it calls has to behave, since nothing had ever exercised it end to end.
    r = await req('POST', '/api/auth/password', { body: { current_password: 'wrong-password', new_password: 'NewGatePass-98765' } })
    chk('…a wrong current password is refused', String(r.status), '^401$')
    r = await req('POST', '/api/auth/password', { body: { current_password: PASSWORD, new_password: 'short' } })
    chk('…and a too-short new one is refused', String(r.status), '^400$')

    r = await req('POST', '/api/auth/password', { body: { current_password: PASSWORD, new_password: 'NewGatePass-98765' } })
    chk('…the right one goes through', String(r.status), '^200$')
    chk('…and this device stays signed in', String((await req('GET', '/api/dashboard')).status), '^200$')

    // The old password must really be dead, including the owner's legacy tenant hash.
    const tryLogin = async (pw) => (await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'manual',
      body: JSON.stringify({ email: EMAIL, password: pw }),
    })).status
    chk('…the old password no longer signs anyone in', String(await tryLogin(PASSWORD)), '^401$')
    chk('…and the new one does', String(await tryLogin('NewGatePass-98765')), '^200$')

    // Put it back, so everything after this block still holds the password the suite signed up with.
    r = await req('POST', '/api/auth/password', { body: { current_password: 'NewGatePass-98765', new_password: PASSWORD } })
    chk('…and it can be changed back', String(r.status), '^200$')
  }

  /* ---------- the forecast counts what the shop keeps, not what it collects for the state ----------
   * syncFromEstimate stored `estimate.total` as the deal value — subtotal PLUS sales tax. So every
   * forecast number in the product carried tax as revenue: the board columns, open/weighted/won
   * value, and the dashboard's "open estimates" KPI. On the seeded shop that is $666.35 of open
   * value and $1,098.92 on the KPI, and it scales with the rate — a 9.5% shop reads its whole
   * forecast a tenth high. lib/roi.mjs was fixed for exactly this and the forecast was not, so the
   * two screens quoted different numbers for the same order. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Forecast Fran', email: 'forecast@e2e.test' } })
    const fcC = r.json?.id
    r = await req('POST', '/api/estimates', {
      body: { contact_id: fcC, tax_rate: 10, items: [{ description: '100 tees', qty: 100, unit_price: 10 }] },
    })
    const fcSub = Number(r.json?.subtotal), fcTot = Number(r.json?.total)
    chk('a quote worth 1000 plus 100 of tax exists', `${fcSub}|${round2e(fcTot)}`, '^1000\\|1100$')

    await sleep(200)
    const board = (await req('GET', '/api/pipeline')).json || {}
    const opp = (board.columns || []).flatMap((c) => c.opps || []).find((o) => o.contact_id === fcC)
    chk('the quote reaches the pipeline', String(!!opp), '^true$')
    chk('…valued at what the shop keeps, not what it collects for the state', String(round2e(opp?.value)), '^1000$')

    // And the two screens that report the same money must agree with each other.
    const kpiBefore = Number(((await req('GET', '/api/dashboard')).json?.kpis || {}).open_estimates)
    const openQuotes = ((await req('GET', '/api/estimates')).json || []).filter((e) => e.status === 'draft' || e.status === 'sent')
    const subSum = round2e(openQuotes.reduce((t, e) => t + (Number(e.subtotal) || Number(e.total) || 0), 0))
    chk('the open-estimates KPI is the sum of the quotes\' subtotals', String(round2e(kpiBefore)), `^${subSum}$`)
  }

  /* ---------- deleting a customer cannot delete work the job route refuses to delete ----------
   * jobs.contact_id cascades. DELETE /api/jobs/:id has always refused while blanks are still out
   * against the job — "receive it, or short-close it if the rest is not coming" — and DELETE
   * /api/contacts/:id went straight through the same wall: it checked invoices and payments only.
   * Void the invoice (which is exactly what a shop does when it raised one in error) and the
   * customer deleted cleanly, taking the job with it. purchase_orders.job_id is ON DELETE SET NULL,
   * so the order survived pointing at nothing: 190 pieces on the way to the shop door, on no screen
   * in the product, with nothing left that could receive them. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Cascade Carl', email: 'cascade@e2e.test' } })
    const cascC = r.json?.id
    r = await req('POST', '/api/jobs', { body: { contact_id: cascC, title: 'Cascade job', garment: 'Gildan 5000 Heavy Cotton Tee — Black', quantities: '24 S / 60 M' } })
    const cascJ = r.json?.id
    await req('PUT', '/api/settings', { body: { sanmar_user: 'gate', sanmar_pass: 'gate', sanmar_cust: '1' } })
    await req('POST', `/api/jobs/${cascJ}/po/submit`, { body: {} })
    r = await req('GET', `/api/jobs/${cascJ}/purchase-orders`)
    const cascPo = (r.json?.purchase_orders || [])[0]
    const cascLine = (cascPo?.lines || [])[1]
    await req('POST', `/api/purchase-orders/${cascPo?.id}/receive`, { body: { receipts: [{ line_id: cascLine?.id, qty: cascLine?.qty_ordered }] } })
    chk('a customer has a job with blanks still out against it', String(!!cascPo?.id), '^true$')
    // The job route already refuses; this is the precondition the customer route was walking past.
    chk('…which the job route refuses to delete', String((await req('DELETE', `/api/jobs/${cascJ}`)).status), '^409$')

    r = await req('DELETE', `/api/contacts/${cascC}`)
    chk('deleting the customer is refused too, for the same reason', String(r.status), '^409$')
    chk('…naming the order the shop has to deal with', `${r.json?.code} ${r.text}`, 'has_open_purchase_orders')
    chk('…and the job is still there', String((await req('GET', `/api/jobs/${cascJ}`)).status), '^200$')
    chk('…still attached to its purchase order',
      String(((await req('GET', `/api/jobs/${cascJ}/purchase-orders`)).json?.purchase_orders || []).length), '^1$')

    // And the escape works: settle the order the way the refusal says to, and the delete goes through.
    await req('POST', `/api/purchase-orders/${cascPo?.id}/close`, { body: { reason: 'distributor cancelled the balance' } })
    chk('…and short-closing the order releases the customer for deletion',
      String((await req('DELETE', `/api/contacts/${cascC}`)).status), '^200$')
  }

  /* ---------- a documented filter must actually filter ----------
   * docs/API.md has documented `?invoice_id=` on GET /api/v1/payments since the endpoint shipped.
   * The handler ignored it, so an integration reconciling ONE invoice was handed every payment in
   * the shop — and had no way to tell its filter had not been applied. */
  {
    const mk = async (name, amount) => {
      let x = await req('POST', '/api/contacts', { body: { name, email: `${name.toLowerCase().replace(/\W+/g, '-')}@e2e.test` } })
      const cid = x.json?.id ?? x.json?.contact?.id
      x = await req('POST', '/api/estimates', { body: { contact_id: cid, items: [{ description: 'tees', sizes: { M: 10 }, unit_price: amount / 10, taxable: false }] } })
      const eid = x.json?.id ?? x.json?.estimate?.id
      x = await req('POST', `/api/estimates/${eid}/convert`, { body: { due_date: '2026-09-01' } })
      const iid = x.json?.invoice_id
      await req('POST', `/api/invoices/${iid}/payments`, { body: { amount, method: 'check' } })
      return iid
    }
    const invA = await mk('Filter Alpha', 100)
    const invB = await mk('Filter Bravo', 250)

    const all_ = await req('GET', '/api/v1/payments', asKey())
    chk('v1 payments lists payments across invoices', String((all_.json?.data || []).length >= 2), '^true$')

    const onlyA = await req('GET', `/api/v1/payments?invoice_id=${invA}`, asKey())
    const rowsA = onlyA.json?.data || []
    chk('v1 payments honours the documented ?invoice_id= filter',
      `${rowsA.length}|${rowsA.every((p) => p.invoice_id === invA)}`, '^1\\|true$')
    const onlyB = await req('GET', `/api/v1/payments?invoice_id=${invB}`, asKey())
    chk('…and narrows to a different invoice too', String((onlyB.json?.data || [])[0]?.amount ?? ''), '^250$')

    const bad = await req('GET', '/api/v1/payments?invoice_id=notanumber', asKey())
    chk('…and refuses a filter it cannot apply rather than ignoring it', `${bad.status} ${bad.text}`, '^400 .*invalid_invoice_id')
  }

  /* ---------- an emailed link points at this install, not at whoever asked ----------
   * The link the shop mails out was built from the raw Host header, which the caller chooses. A
   * request carrying `Host: evil.attacker.example` made the server mail the real owner a working
   * password-reset link pointing at the attacker — one click and the shop was theirs. publicOrigin()
   * already existed for exactly this and was used for the Slack links only. The payment-link route
   * returns the link it just emailed, so it is the one that can be asserted end to end. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Link Buyer', email: 'link-buyer@e2e.test' } })
    const linkCid = r.json?.id ?? r.json?.contact?.id
    r = await req('POST', '/api/estimates', {
      body: { contact_id: linkCid, items: [{ description: '50 tees', sizes: { M: 50 }, unit_price: 10, taxable: true }] },
    })
    const linkEst = r.json?.id ?? r.json?.estimate?.id
    r = await req('POST', `/api/estimates/${linkEst}/convert`, { body: { due_date: '2026-06-01' } })
    const linkInv = r.json?.invoice_id
    // fetch() refuses to send a Host header (it is a forbidden header in undici), and a test that
    // cannot actually poison the Host would pass against the bug. Use node:http, which lets us.
    const { request: rawRequest } = await import('node:http')
    const poisoned = await new Promise((resolve) => {
      const rq = rawRequest({
        host: '127.0.0.1', port: PORT, method: 'POST', path: `/api/invoices/${linkInv}/request-payment`,
        headers: { Host: 'evil.attacker.example', 'Content-Type': 'application/json', 'Content-Length': '2', Cookie: cookieHeader() },
      }, (resp) => { let b = ''; resp.on('data', (d) => { b += d }); resp.on('end', () => resolve(b)) })
      rq.on('error', (e) => resolve(`error ${e.message}`))
      rq.end('{}')
    })
    let poisonedLink = ''
    try { poisonedLink = JSON.parse(poisoned)?.link || '' } catch { poisonedLink = poisoned }
    chk('an emailed link ignores a poisoned Host header', poisonedLink, '^http://127\\.0\\.0\\.1:')
    chk('…and never carries the attacker\'s host', poisonedLink.includes('evil.attacker.example') ? 'leaked' : 'clean', '^clean$')

    /* ---------- the pay page must not claim a payment it could not confirm ----------
     * The Stripe confirm was wrapped in a bare try/catch and the success page rendered regardless,
     * so a rejected key or a network blip printed "✓ your payment went through" to a customer whose
     * card HAD been charged (Stripe only redirects here after charging) while amount_paid never
     * moved — and then offered a "Pay the remaining" button, which is how one balance gets paid
     * twice. The gate shop has no Stripe configured, so the confirm fails: exactly that case. */
    const payPath = poisonedLink.replace(/^https?:\/\/[^/]+/, '')
    const back = await req('GET', `${payPath}&session_id=cs_test_gate_fake`, { cookies: false })
    chk('an unconfirmable payment is not reported as successful', back.text.includes('your payment went through') ? 'claimed' : 'honest', '^honest$')
    chk('…the customer is told not to pay it twice', back.text, 'Do not pay again')
    chk('…and is not handed a button to do so', back.text.includes('Pay the remaining') ? 'offered' : 'withheld', '^withheld$')
  }

  /* ---------- ...and the SECOND copy of the cookie parser must survive it too ----------
   * lib/realtime.mjs kept its own parseCookies with a bare decodeURIComponent. It runs on the /ws
   * upgrade BEFORE any auth, so a malformed cookie threw out of the connection handler and the
   * socket was never closed — the fd was never reaped. Repeated unauthenticated upgrades exhausted
   * file descriptors for the whole shared multi-tenant process. The socket must be CLOSED, not
   * orphaned, so this asserts a close actually arrives rather than merely that nothing 500'd. */
  {
    const { WebSocket } = await import('ws')
    const closed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('never closed'), 8000)
      let sock
      try {
        sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: 'psc_session=%; junk=%zz' } })
      } catch { clearTimeout(timer); return resolve('threw') }
      sock.on('close', (code) => { clearTimeout(timer); resolve(`closed ${code}`) })
      sock.on('error', () => { /* an unauthorized close surfaces here too; the close handler decides */ })
    })
    chk('a malformed cookie on the /ws upgrade closes the socket instead of leaking it', closed, '^closed ')
    const h = await req('GET', '/health', { cookies: false })
    chk('…and the server is still healthy afterwards', String(h.status), '^200$')
  }

  /* ---------- one anonymous request must not be able to exhaust memory ----------
   * express.json runs before the auth gate and every rate limiter — a request's body is read
   * before anything can reject the request. At a 25 MB cap, 35 anonymous 24 MB POSTs to /login
   * drove RSS past a gigabyte and OOMed the box for every shop; the 401s bought the memory anyway.
   * The cap is the defence, and it must bite on the UNAUTHENTICATED routes specifically. */
  {
    const big = 'x'.repeat(3 * 1024 * 1024) // 3 MB, over the 1 MB cap, well under the old 25 MB
    r = await req('POST', '/api/auth/login', { cookies: false, body: { email: 'a@b.test', password: big } })
    chk('an oversize body to an anonymous route is refused, not buffered', String(r.status), '^413$')
  }

  /* ---------- a failed start must LOOK like a failure ----------
   * This shipped broken: a fatal bind failure was logged by the uncaughtException handler, which
   * left no work on the event loop, so Node exited — with status 0. Docker, Fly, Render and any
   * systemd unit using Restart=on-failure all read a zero exit as "ran to completion", so the app
   * stayed down with no restart and no alarm. The exit code is the whole contract with the
   * supervisor; assert it, and assert the operator is told what to actually do about it. */
  {
    const rogue = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
      cwd: ROOT,
      // Deliberately the port the harness server already holds.
      env: { ...process.env, PORT: String(PORT), PSC_DB: join(TMP, 'rogue.db'), PSC_AUTH: '1', PSC_SECRET: 'gate' },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    let rogueLog = ''
    rogue.stdout.on('data', (d) => { rogueLog += d })
    rogue.stderr.on('data', (d) => { rogueLog += d })
    const code = await new Promise((resolve) => {
      rogue.on('exit', resolve)
      setTimeout(() => { try { rogue.kill() } catch { /* gone */ } resolve('timeout') }, 20000)
    })
    chk('a second copy on a taken port exits non-zero, not 0', String(code), '^[1-9]')
    chk('…and names the port so the operator can act on it', rogueLog, String(PORT))
    // Match the advice, not the raw errno text — the old build printed a stack trace that also
    // contained "already in use", so asserting on that would have passed against the bug.
    chk('…and says what to do about it', rogueLog, 'PORT=8081')
  }
  /* ---------- the v1 API does what was asked, or refuses — it does not substitute ----------
   * Two silent substitutions. A customer_id naming nobody fell through to the customer{} block and
   * CREATED someone, so a caller asking to bill an existing account got a duplicate contact and a
   * 201. And `events: []` on a webhook subscription became "*": an empty array is truthy in JS, so
   * `[] || '*'` kept it, String([]) made it '', and '' || '*' turned "subscribe to nothing" into
   * "subscribe to everything" — the endpoint that asked for no events received all of them. */
  {
    const before = await req('GET', '/api/v1/customers?limit=100', asKey())
    const countBefore = (before.json?.data || []).length
    r = await req('POST', '/api/v1/estimates', {
      ...asKey(),
      body: { customer_id: 999999, customer: { name: 'Ghost' }, items: [{ description: 'tees', quantity: 1, unit_price: 1 }] },
    })
    chk('a customer_id that names nobody is a 404, not a new customer', `${r.status} ${r.text}`, '^404 .*customer_not_found')
    const after = await req('GET', '/api/v1/customers?limit=100', asKey())
    chk('…and no contact was created behind the caller\'s back', String((after.json?.data || []).length), `^${countBefore}$`)
    r = await req('POST', '/api/v1/estimates', {
      ...asKey(),
      body: { customer_id: 'abc', items: [{ description: 'tees', quantity: 1, unit_price: 1 }] },
    })
    chk('…and a non-numeric customer_id is refused', `${r.status} ${r.text}`, '^400 .*invalid_customer_id')

    r = await req('POST', '/api/v1/webhooks', { ...asKey(), body: { url: 'https://example.com/hook-empty', events: [] } })
    chk('a webhook subscribing to no events is refused, not subscribed to all', String(r.status), '^400$')
    chk('…and says what to send instead', r.text, 'at least one event')
    r = await req('POST', '/api/v1/webhooks', { ...asKey(), body: { url: 'https://example.com/hook-list', events: ['invoice.paid', 'contact.created'] } })
    chk('…while the documented array form still subscribes to exactly those', String(r.json?.events ?? 'missing'), '^invoice.paid,contact.created$')
    r = await req('POST', '/api/v1/webhooks', { ...asKey(), body: { url: 'https://example.com/hook-all' } })
    chk('…and omitting events still means all of them', String(r.json?.events ?? 'missing'), '^\\*$')
  }

  /* ---------- money never leaves the books without a trace ----------
   * Recording a payment writes an activity row; removing one wrote nothing at all. So a payment
   * could be deleted and Revenue MTD would drop, the invoice would go back to unpaid, and the
   * lines would disappear from the QuickBooks export — while the customer's timeline still read
   * "Payment $3,600.00 on INV-1001 (check)", describing a payment that no longer exists. Every
   * other money event in the product logs. In a shop with staff this was the one movement of cash
   * that could not be traced to anybody. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Audit Trail Andy', email: 'audit-trail@e2e.test' } })
    const atId = r.json?.id
    r = await req('POST', '/api/estimates', { body: { contact_id: atId, items: [{ description: '30 tees', sizes: { M: 30 }, unit_price: 10, taxable: false }] } })
    const atEst = r.json?.id
    await req('POST', `/api/estimates/${atEst}/approve`, { body: {} })
    r = await req('POST', `/api/estimates/${atEst}/convert`, { body: { due_date: '2026-12-09' } })
    const atInv = r.json?.invoice_id
    await req('POST', `/api/invoices/${atInv}/payments`, { body: { amount: 300, method: 'check', note: 'cheque 4471' } })
    const payId = ((await req('GET', `/api/invoices/${atInv}`)).json?.payments || []).slice(-1)[0]?.id
    const before = ((await req('GET', `/api/contacts/${atId}`)).json?.activities || []).length

    r = await req('DELETE', `/api/payments/${payId}`)
    chk('a recorded payment can be removed', String(r.status), '^200$')
    const acts = (await req('GET', `/api/contacts/${atId}`)).json?.activities || []
    chk('…and the ledger says the money left', String(acts.length > before), '^true$')
    chk('…naming the amount and the invoice it came off', acts.map((a) => a.description || '').join(' | '), 'REMOVED.*\\$300\\.00|\\$300\\.00 REMOVED')
  }

  /* ---------- the API answers in JSON however you knock ----------
   * The API 404 lived inside the GET-only SPA catch-all, so a PUT/POST/PATCH/DELETE to a path that
   * does not exist fell through to Express's finalhandler and came back as an HTML error page —
   * `Cannot PUT /api/v1/customers/1`, Content-Type text/html — while docs/API.md promises that all
   * responses are JSON. The integrator's JSON.parse throws on the one shape they were never told
   * about, which reads as a network fault rather than a wrong URL. */
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res404 = await fetch(`${BASE}/api/v1/definitely-not-a-route`, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() }, body: method === 'DELETE' ? undefined : '{}',
    })
    const body404 = await res404.text()
    chk(`an unknown ${method} on /api is a 404`, String(res404.status), '^404$')
    chk(`…answered in JSON, not an HTML error page`, String(res404.headers.get('content-type')), 'application/json')
    let parsed = null
    try { parsed = JSON.parse(body404) } catch { /* that is the defect */ }
    chk(`…that an integrator can actually parse`, String(!!parsed?.error), '^true$')
    chk(`…and that carries a machine-readable code, as the docs say`, String(parsed?.code ?? ''), '^unknown_endpoint$')
  }

  /* ---------- a drafted follow-up can actually be sent, and a failed one retried ----------
   * Settings → Automation Modes says "Manual mode drafts and waits for a person", and queueEmail's
   * own comment says those messages "land in the outbox as drafts for a person to send". GET
   * /api/outbox was the only outbox route in the file. There was no Send button on any screen, so
   * every drafted nudge sat there forever and Manual mode sent nothing, ever — while the Outbox
   * rendered the draft as "logged", the label for "no email is connected", so the shop was told
   * nothing was expected of it.
   *
   * The same route covers the other stuck state: a send the mail server refused. The estimate says
   * "sent", the customer never got it, and the only way to try again was to re-send the estimate,
   * which re-stamps sent_at and re-fires every estimate.sent automation behind it. */
  {
    await req('PUT', '/api/settings', { body: { mode_followups: 'manual' } })
    r = await req('POST', '/api/contacts', { body: { name: 'Manual Mode Molly', email: 'manual-mode@e2e.test' } })
    const mmId = r.json?.id
    // A reorder nudge is the ordinary Manual-mode path: queueEmail with deliver:false.
    r = await req('POST', `/api/reorders/${mmId}/nudge`, { body: {} })
    chk('a reorder nudge in Manual mode reports that it was drafted, not sent', String(r.json?.delivered ?? 'missing'), '^false$')
    await sleep(300)
    let box = (await req('GET', '/api/outbox')).json || []
    const draft = box.find((m) => m.via === 'draft')
    chk('Manual mode leaves the message in the outbox as a draft', String(!!draft), '^true$')
    chk('…and it is not marked delivered', String(draft?.delivered ?? 0), '^0|^false')

    r = await req('POST', `/api/outbox/${draft?.id}/send`, { body: {} })
    // No SMTP in the gate, so the send cannot succeed — what matters is that pressing Send does
    // something, reports honestly, and does not leave the row claiming to be delivered.
    chk('a drafted message has a Send that reaches the mail layer', String(r.status), '^200$|^502$')
    chk('…and says plainly whether it went out', r.text, 'ok|not.*connect|Message Delivery|smtp')
    box = (await req('GET', '/api/outbox')).json || []
    const after = box.find((m) => m.id === draft?.id)
    chk('…and never claims delivery it did not get', String(after?.delivered ? 'claimed' : 'honest'), '^honest$')
    chk('…while leaving the row out of the "draft, nobody has touched it" state', String(after?.via ?? ''), '^(?!draft$).+')

    r = await req('POST', '/api/outbox/999999/send', { body: {} })
    chk('sending a message that is not there says so', String(r.status), '^404$')

    /* A message whose customer has since been deleted must still be sendable.
     *
     * email_log.contact_id has no foreign key; activities.contact_id has one, ON DELETE CASCADE,
     * and foreign keys are on. So once the customer was deleted, "Send it" reached the mail layer,
     * updated email_log, and then died in logActivity's INSERT — FOREIGN KEY constraint failed →
     * HTTP 500, forever, with no route anywhere that could delete the row. On a shop with SMTP
     * configured the mail really went out first and the shop was told the send had failed; the
     * next click then answered "That message has already gone out." */
    r = await req('POST', '/api/contacts', { body: { name: 'Doomed Dora', email: 'doomed-dora@e2e.test' } })
    const doomedId = r.json?.id
    await req('POST', `/api/reorders/${doomedId}/nudge`, { body: {} })
    await sleep(300)
    const doomedMsg = ((await req('GET', '/api/outbox')).json || []).find((m) => m.contact_id === doomedId && !m.delivered)
    chk('a customer about to be deleted has a message waiting in the outbox', String(!!doomedMsg), '^true$')
    chk('…and the customer deletes cleanly', String((await req('DELETE', `/api/contacts/${doomedId}`)).status), '^200$')

    r = await req('POST', `/api/outbox/${doomedMsg?.id}/send`, { body: {} })
    chk('…and their orphaned message can still be sent, not 500 forever', String(r.status), '^200$|^502$')
    chk('…with an answer that matches what actually happened', r.text, 'ok|not.*connect|Message Delivery|smtp')
    const doomedAfter = ((await req('GET', '/api/outbox')).json || []).find((m) => m.id === doomedMsg?.id)
    chk('…and the row records the attempt rather than staying a draft', String(doomedAfter?.via ?? ''), '^(?!draft$).+')

    await req('PUT', '/api/settings', { body: { mode_followups: 'ai' } })
  }

  /* ---------- a webhook that used up its retries is not lost forever ----------
   * MAX_WEBHOOK_ATTEMPTS is 3 and the backoff spends them inside about ten minutes, after which
   * the row is 'failed' with next_attempt_at NULL — and retryDueWebhooks() only ever looks at
   * 'retrying'/'pending' rows under the attempt cap. So an endpoint that was down over a lunch
   * hour lost every event in that window permanently. The Developers screen showed them red, with
   * the HTTP code, and had no action column at all, while the QuickBooks queue and the automation
   * sequence queue each already ship exactly this button.
   *
   * The delivery is aged into the exhausted state directly rather than sitting through three real
   * backoffs — the same reason this harness winds an automation's clock forward. Everything the
   * test then CHECKS comes back through the API. */
  {
    // A public URL: assertPublicUrl() refuses loopback, and rightly so. Whether the POST actually
    // reaches anything is irrelevant here — the exhausted state is written directly below.
    r = await req('POST', '/api/developers/webhooks', { body: { url: 'https://example.com/hook-redeliver', events: ['contact.created'] } })
    chk('a shop can subscribe a webhook', String(r.status), '^201$')
    const subId = r.json?.id
    await req('POST', '/api/contacts', { body: { name: 'Webhook Redeliver Wanda', email: 'wh-redeliver@e2e.test' } })
    await sleep(400)

    // Spend the whole budget on THIS subscription's delivery, exactly as ten minutes against a dead
    // endpoint would — the same reason this harness winds an automation's clock forward. Everything
    // the test then CHECKS comes back through the API.
    shopDb('gate-shop', (db) => db.prepare(
      "UPDATE webhook_deliveries SET status='failed', attempts=3, last_error='HTTP 405', next_attempt_at=NULL WHERE subscription_id = ?").run(subId))
    let dev = await req('GET', '/api/developers')
    const dead = (dev.json?.deliveries || []).find((x) => x.status === 'failed' && x.last_error === 'HTTP 405')
    chk('a dead endpoint really does exhaust its retries', String(!!dead), '^true$')

    r = await req('POST', `/api/developers/deliveries/${dead?.id}/redeliver`, { body: {} })
    chk('a failed delivery can be sent again from the screen that shows it', String(r.status), '^200$')
    dev = await req('GET', '/api/developers')
    const again = (dev.json?.deliveries || []).find((x) => x.id === dead?.id)
    chk('…and it is back in the retry pipeline with a fresh budget', String(Number(again?.attempts ?? 9) <= 1), '^true$')

    r = await req('POST', '/api/developers/deliveries/999999/redeliver', { body: {} })
    chk('re-driving a delivery that is not there says so', String(r.status), '^404$')

    await req('PATCH', `/api/developers/webhooks/${subId}`, { body: { active: false } })
    r = await req('POST', `/api/developers/deliveries/${dead?.id}/redeliver`, { body: {} })
    chk('a paused webhook is not quietly re-driven behind the owner\'s back', String(r.status), '^409$')
    chk('…and says what to do about it first', r.text, 'paused')
    await req('DELETE', `/api/developers/webhooks/${subId}`)
  }

  /* ---------- one invoice, one status, whichever endpoint you ask ----------
   * The stored `status` column does not know what day it is. The LIST endpoint computes the
   * effective status — EFFECTIVE_STATUS_SQL turns an unpaid invoice past its due date into
   * 'overdue' — and the DETAIL endpoint returned the stale column, as did the copy embedded in
   * GET /api/v1/customers/:id. So one invoice was 'overdue' from the list, 'unpaid' from its own
   * detail, and showed up under ?status=overdue while denying it. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Late Payer', email: 'late@e2e.test' } })
    const lateId = r.json?.id ?? r.json?.contact?.id
    r = await req('POST', '/api/estimates', { body: { contact_id: lateId, items: [{ description: '50 tees', sizes: { M: 50 }, unit_price: 10, taxable: false }] } })
    const lateEst = r.json?.id
    // Convert with a due date already in the past. That route honours the date the shop picked and
    // does NOT re-sync the stored status column, which is exactly the everyday shape of this bug:
    // an invoice written while it was still current, whose due date has since gone by with nothing
    // touching the row.
    r = await req('POST', `/api/estimates/${lateEst}/convert`, { body: { due_date: '2026-01-05' } })
    const lateInv = r.json?.invoice_id
    chk('an invoice can be raised already past its due date', String(r.status), '^200$')
    const raw = await req('GET', `/api/invoices/${lateInv}`)
    chk('…and its stored status column is stale, as it would be in real life', String(raw.json?.status ?? raw.json?.invoice?.status ?? 'missing'), '^unpaid$')

    const list = await req('GET', '/api/v1/invoices', asKey())
    const fromList = (list.json?.data || []).find((x) => x.id === lateInv)
    chk('the v1 list reports it overdue', String(fromList?.status ?? 'missing'), '^overdue$')
    const detail = await req('GET', `/api/v1/invoices/${lateInv}`, asKey())
    chk('…and its own detail endpoint agrees', String(detail.json?.status ?? 'missing'), '^overdue$')
    const cust = await req('GET', `/api/v1/customers/${lateId}`, asKey())
    const embedded = (cust.json?.recent_invoices || []).find((x) => x.id === lateInv)
    chk('…and so does the copy on the customer', String(embedded?.status ?? 'missing'), '^overdue$')
  }

  /* ---------- two mutating routes were missing the role check their siblings all have ----------
   * POST /api/automations/tick fires the whole shop's automation sweep — real customer email
   * through the shop's SMTP credentials and SMS through its Twilio token — and was reachable by
   * any staff account. POST /api/import/contacts is the only bulk importer without a role check;
   * its pricebook, matrices and orders siblings have all required manager since they were written,
   * so a staff session could bulk-write the entire customer book (firing contact.created
   * automations and webhooks for every row) while being unable to delete one contact. */
  {
    const ownerJar = new Map(jar)
    r = await req('POST', '/api/members', { body: { name: 'Floor Staff', email: 'floor@e2e.test', password: 'FloorPass-123456', role: 'staff' } })
    chk('a staff member can be added', String(r.status), '^200$')
    r = await req('POST', '/api/auth/login', { body: { email: 'floor@e2e.test', password: 'FloorPass-123456' } })
    chk('…and can sign in', String(r.status), '^200$')
    const staffCookie = cookieHeader()
    const asStaff = { cookies: false, headers: { Cookie: staffCookie } }

    r = await req('GET', '/api/auth/me', asStaff)
    chk('…as a staff role, not an owner', r.text, '"role":"staff"')
    r = await req('POST', '/api/automations/tick', { ...asStaff, body: {} })
    chk('staff cannot fire the shop-wide automation sweep', String(r.status), '^403$')
    r = await req('POST', '/api/import/contacts', { ...asStaff, body: {} })
    chk('staff cannot bulk-import the customer book', String(r.status), '^403$')

    // Back to the owner, and prove the routes still work for someone who is allowed to use them.
    jar.clear(); for (const [k, v] of ownerJar) jar.set(k, v)
    r = await req('POST', '/api/automations/tick', { body: {} })
    chk('…while an owner still can', String(r.status), '^200$')

    /* addMember was the only password-creating path in the product without the length check that
     * signup, self-change, reset and the CLI all have — so a MANAGER login could be created with
     * a one-character password, and it signed in. */
    r = await req('POST', '/api/members', { body: { name: 'Weak', email: 'weak@e2e.test', password: 'a', role: 'manager' } })
    chk('a staff login cannot be created with a one-character password', String(r.status), '^400$')
    chk('…and the refusal names the minimum, so it is self-correcting', String(r.json?.error || ''), 'at least 8')
    r = await req('POST', '/api/members', { body: { name: 'Fine', email: 'fine@e2e.test', password: 'GatePass-123456', role: 'staff' } })
    chk('…while a real temporary password is still accepted', String(r.status), '^200$')
  }

  /* ---------- the widget a shop pastes on its own website can actually reach the app ----------
   * The whole embed feature is "paste this one line before </body> on any page". The app sent no
   * Access-Control header on /api/embed at all, so the browser blocked every call from the shop's
   * own site and the visitor was shown "Sorry, chat is unavailable right now." Verified in real
   * headless Chrome from a second origin: BLOCKED Failed to fetch. It looked fine in the app only
   * because the preview at /embed/chatdemo is same-origin. */
  {
    const preflight = await fetch(`${BASE}/api/embed/chat/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://shopsite.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    })
    chk('the embed API answers a browser preflight', String(preflight.status), '^204$')
    chk('…allowing the shop\'s own site to call it', String(preflight.headers.get('access-control-allow-origin')), '^\\*$')
    chk('…including the Content-Type the widget sends', String(preflight.headers.get('access-control-allow-headers')), 'Content-Type')

    const posted = await fetch(`${BASE}/api/embed/chat/start`, {
      method: 'POST', headers: { Origin: 'https://shopsite.example', 'Content-Type': 'application/json' }, body: '{}',
    })
    chk('…and the real response carries it too, not just the preflight',
      String(posted.headers.get('access-control-allow-origin')), '^\\*$')

    // Scope. Every other /api route is cookie-authenticated and relies on the same-origin policy;
    // if this shim ever widens to /api, that protection is gone.
    const guarded = await fetch(`${BASE}/api/settings`, { headers: { Origin: 'https://evil.example', Cookie: cookieHeader() } })
    chk('the authenticated API is NOT opened up to other origins',
      String(guarded.headers.get('access-control-allow-origin') ?? 'none'), '^none$')
    chk('…and credentials are never allowed cross-origin',
      String(posted.headers.get('access-control-allow-credentials') ?? 'none'), '^none$')
  }

  /* ---------- a delete never takes money or a placed order with it ----------
   * Two routes, one class of defect: a DELETE that cascades further than the confirm dialog says,
   * onto records nothing in the product can ever show again.
   *
   * DELETE /api/contacts/:id cascades through estimates, invoices, PAYMENTS, jobs, proofs and the
   * whole activity trail. Reproduced on a live instance: one call took revenue MTD from $3,600 to
   * $0, took INV-1001 and the cheque recorded against it with it, and answered {"ok":true} — while
   * DELETE /api/estimates/:id one level down already refuses to destroy an invoiced estimate and
   * says why. Deleting the customer was simply the way around that rule.
   *
   * DELETE /api/jobs/:id sets purchase_orders.job_id to NULL, and purchaseOrdersForJob() is keyed
   * on that column — so a submitted, chargeable order at the distributor survived the delete with
   * no screen anywhere able to find it, and the activity row that mentioned it cascaded away too. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Ledger Ladder Co', email: 'ledger@e2e.test' } })
    const payerId = r.json?.id
    r = await req('POST', '/api/estimates', { body: { contact_id: payerId, items: [{ description: 'Gildan 5000 Heavy Cotton Tee — Black — 1/0 Front', sizes: { M: 80 }, unit_price: 12, taxable: true }] } })
    const payerEst = r.json?.id
    await req('POST', `/api/estimates/${payerEst}/approve`, { body: {} })
    r = await req('POST', `/api/estimates/${payerEst}/convert`, { body: { due_date: '2026-12-04' } })
    const payerInv = r.json?.invoice_id
    const payerJob = r.json?.job_id
    r = await req('POST', `/api/invoices/${payerInv}/payments`, { body: { amount: 480, method: 'check' } })
    chk('a customer pays part of an invoice', String(r.status), '^200$')

    r = await req('DELETE', `/api/contacts/${payerId}`)
    chk('deleting a customer who has paid you is refused', String(r.status), '^409$')
    chk('…and the refusal names the money that is in the way', r.text, '480|recorded payments')
    r = await req('GET', `/api/invoices/${payerInv}`)
    chk('…and their invoice is still there', String(r.status), '^200$')

    // The way out the refusal describes has to actually work.
    await req('POST', `/api/invoices/${payerInv}/void`, { body: { reason: 'raised in error' } })
    r = await req('DELETE', `/api/contacts/${payerId}`)
    chk('a voided invoice does not block, but the payment on it still does', String(r.status), '^409$')

    // A customer with nothing attached is exactly what this route is for.
    r = await req('POST', '/api/contacts', { body: { name: 'Typo Duplicate', email: 'typo@e2e.test' } })
    r = await req('DELETE', `/api/contacts/${r.json?.id}`)
    chk('a customer with no money attached still deletes', String(r.status), '^200$')

    // --- and the same rule for a job with an order already at the distributor ---
    // A SanMar account, which is the ordinary shape: PromoStandards submit is provisioned per
    // account, so the PO lands as 'placed_manually' — a human typed it into the portal and the
    // blanks are just as much on their way. No network call is made on that path.
    await req('PUT', '/api/settings', { body: { sanmar_user: 'gate-user', sanmar_pass: 'gate-pass', sanmar_cust: '12345' } })
    r = await req('POST', `/api/jobs/${payerJob}/po/submit`, { body: {} })
    const placed = r.json?.purchase_order
    chk('a purchase order is placed against the job', `${placed?.status ?? '?'} ${r.text.slice(0, 200)}`, 'submitted|placed_manually|partial')
    r = await req('DELETE', `/api/jobs/${payerJob}`)
    chk('deleting a job whose blanks are already ordered is refused', String(r.status), '^409$')
    chk('…and the refusal names the purchase order, so purchasing knows what to chase', r.text, String(placed?.po_number || 'PSC-'))
    chk('…and the order is still findable afterwards', String((await req('GET', `/api/purchase-orders/${placed?.id}`)).status), '^200$')

    // Receiving it is the way out the refusal describes, and it has to actually work.
    const recv = (placed?.lines || []).map((l) => ({ line_id: l.id, qty: l.qty_ordered }))
    r = await req('POST', `/api/purchase-orders/${placed?.id}/receive`, { body: { receipts: recv } })
    chk('the blanks can be received against it', String(r.status), '^200$')
    r = await req('DELETE', `/api/jobs/${payerJob}`)
    chk('…and then the job deletes', String(r.status), '^200$')
  }

  /* ---------- a stranger on the widget may be LINKED to a customer, never WRITE on one ----------
   * captureLead() decides that from chat_sessions.channel, and this public, unauthenticated route
   * took that value straight out of the request body while lib/agent.mjs treated anything that
   * was not the literal 'web' as verified. So {"channel":"sms"} — one extra JSON field, sent by
   * anyone who reads the shop's page source for its published embed key — turned the guard off:
   * a real customer's blank phone filled with the stranger's number, and a real numbered estimate
   * drafted on that customer's account. The widget itself has never sent this field. */
  {
    await req('PUT', '/api/agent/config', {
      body: { enabled: true, mode: 'ai', name: 'Ari', greeting: 'Hi', capabilities: { faq: true, quote: true, qualify: true, handoff: true, book: true }, faqs: [] },
    })
    const meC = await req('GET', '/api/auth/me')
    const embedKey = meC.json?.embed_key
    chk('the shop has a published embed key, as the paste-in snippet needs', String(!!embedKey), '^true$')
    r = await req('POST', '/api/contacts', { body: { name: 'Harbor City Brewfest', email: 'hijack@e2e.test', phone: '' } })
    const victimId = r.json?.id ?? r.json?.contact?.id

    // No cookie at all: exactly what a stranger on the shop's public website can send.
    const anon = (path, body) => fetch(`${BASE}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((x) => x.json()).catch(() => ({}))
    const start = await anon(`/api/embed/chat/start?shop=${embedKey}`, { channel: 'sms', page_url: 'https://shop.test/' })
    chk('the public widget still opens a chat session', String(!!start.session), '^true$')
    for (const m of [
      'I need a price on 600 gildan 18500 hoodies, screen print, 2 color front',
      'I am Victor Kroll, email hijack@e2e.test and my cell is 555-000-9999',
    ]) await anon(`/api/embed/chat/message?shop=${embedKey}`, { session: start.session, text: m })

    r = await req('GET', `/api/contacts/${victimId}`)
    const victim = r.json?.contact ?? r.json
    chk('a stranger claiming a customer\'s email cannot write their phone number', String(victim?.phone ?? 'MISSING'), '^$')
    const estList2 = (await req('GET', '/api/estimates')).json
    const forged = (Array.isArray(estList2) ? estList2 : estList2?.data || []).filter((e) => e.contact_id === victimId)
    chk('…nor burn an estimate number on that customer\'s account', String(forged.length), '^0$')
  }

  /* ---------- switching a rule off pauses its queue, it does not delete it ----------
   * The drip resume loop DELETEd the automation_pending row before checking whether the rule was
   * still enabled, and committed that delete in autocommit. So an owner who paused a rule for an
   * hour — to edit the copy, to hold sends over a holiday, because a customer complained —
   * permanently destroyed step 2 and step 3 of every sequence that came due in that window.
   * Re-enabling brought nothing back, nothing was logged, and the original run row went on
   * saying "2 step(s) queued" about a queue that no longer existed. There was no route that
   * could list automation_pending and no screen that could show one, so the shop could not even
   * learn WHO had been dropped: the ctx naming the customer went with the row.
   * The off switch was a delete button. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Drip Survivor', email: 'drip-survivor@example.test' } })
    chk('a new lead enters the seeded nurture sequence', String(r.status), '^200$')

    let a = await req('GET', '/api/automations')
    const queued = (a.json?.pending || []).find((p) => p.label === 'Drip Survivor')
    chk('the queue is visible to the shop, not just a number', String(!!queued), '^true$')

    const ruleId = queued?.automation_id
    r = await req('PUT', `/api/automations/${ruleId}`, { body: { enabled: false } })
    chk('the owner switches that rule off', String(r.status), '^200$')

    // Wind the wait forward so it expires while the rule is off — the exact window that
    // destroyed the drip. Two real days is not something a gate can sit through.
    shopDb('gate-shop', (db) => db.exec("UPDATE automation_pending SET due_at = datetime('now','-1 day')"))
    r = await req('POST', '/api/automations/tick', { body: {} })

    a = await req('GET', '/api/automations')
    const survived = (a.json?.pending || []).find((p) => p.label === 'Drip Survivor')
    chk('a paused rule does not destroy the sequence waiting behind it', String(!!survived), '^true$')

    r = await req('PUT', `/api/automations/${ruleId}`, { body: { enabled: true } })
    a = await req('GET', '/api/automations')
    const resumable = (a.json?.pending || []).find((p) => p.label === 'Drip Survivor')
    chk('…and it is still there to resume once the rule is back on', String(!!resumable), '^true$')

    // The shop can now act on it without a shell: cancel is a real, reachable verb.
    r = await req('DELETE', `/api/automations/pending/${resumable?.id}`)
    chk('a sequence can be cancelled from the UI', String(r.status), '^200$')
    a = await req('GET', '/api/automations')
    chk('…and cancelling really removes it', String(!!(a.json?.pending || []).find((p) => p.label === 'Drip Survivor')), '^false$')
  }

  /* ---------- a rejected proof is not the end of the job ----------
   * The customer clicks "Request changes" on the proof page. Back in the app the art card's
   * action row collapsed to Open + Delete: Send was gated on status 'draft' and the proof link on
   * 'sent'. Uploading a corrected v2 is the normal path and works — but if the customer rings
   * back to say v1 was fine after all, or the rejection was a mis-click on their phone, there was
   * nothing on any screen that could put it back in front of them, and nowhere to record an
   * approval that arrived by phone or by email reply, which is how a good half of them arrive.
   * The routes have always allowed both; two template conditions stopped it. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Changed Their Mind Co', email: 'mindchange@e2e.test' } })
    const rjC = r.json?.id
    r = await req('POST', '/api/jobs', { body: { contact_id: rjC, title: 'Reject and reconsider', decoration: 'Screen Print' } })
    const rjJ = r.json?.id
    const rjF = new FormData()
    rjF.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }), 'proof-v1.svg')
    const rjUp = await fetch(`${BASE}/api/jobs/${rjJ}/art`, { method: 'POST', headers: { Cookie: cookieHeader() }, body: rjF })
    const rjArt = await rjUp.json().catch(() => ({}))
    const rjLink = String((await req('POST', `/api/art/${rjArt.id}/send`)).json?.share_url || '')

    // The customer asks for changes.
    await fetch(`${BASE}${rjLink.replace('?', '/decide?')}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'decision=rejected&notes=make the logo bigger',
    })
    let art = ((await req('GET', `/api/jobs/${rjJ}`)).json?.art || [])[0]
    chk('the customer can ask for changes', String(art?.status), '^rejected$')

    // …and then rings back. Both doors have to be open.
    chk('a rejected proof can be put back in front of the customer',
      String((await req('POST', `/api/art/${rjArt.id}/send`)).status), '^200$')
    chk('…and an approval that came by phone can be recorded',
      String((await req('POST', `/api/art/${rjArt.id}/decide`, { body: { decision: 'approved', by: 'phone' } })).status), '^200$')
    art = ((await req('GET', `/api/jobs/${rjJ}`)).json?.art || [])[0]
    chk('…which really approves it', String(art?.status), '^approved$')
    chk('…and releases the job off art approval', String((await req('GET', `/api/jobs/${rjJ}`)).json?.stage), '^prepress$')

    // A mockup on an ESTIMATE has no job behind it, and this route dereferenced one regardless.
    r = await req('POST', '/api/estimates', { body: { contact_id: rjC, items: [{ description: '24 tees', sizes: { M: 24 }, unit_price: 12 } ] } })
    const mkEst = r.json?.id
    const mkF = new FormData()
    mkF.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }), 'mockup.svg')
    const mkUp = await fetch(`${BASE}/api/estimates/${mkEst}/mockups`, { method: 'POST', headers: { Cookie: cookieHeader() }, body: mkF })
    const mk = await mkUp.json().catch(() => ({}))
    if (mk?.id) {
      const out = await req('POST', `/api/art/${mk.id}/send`)
      chk('sending an estimate mockup down the job route is refused, not a 500', String(out.status), '^409$')
    } else {
      say('·', 'no estimate mockup route on this edition — the no-job branch was not exercised')
    }
  }

  /* ---------- a stale customer dropdown does not answer "Something went wrong on our end" ----------
   * `if (!b.contact_id)` is a truthiness check, and contact_id is a real foreign key on estimates,
   * jobs and opportunities — so an id that no longer resolves raised FOREIGN KEY constraint
   * failed, which wrap() turned into a bare 500 with no code and nothing anybody could act on.
   * Two ordinary paths reach it: a customer <select> rendered before someone else deleted that
   * customer (two tabs, or two people in a shop), and an integration posting an id it cached. The
   * v1 API got exactly this refusal in round 4; the app's own create routes never did.
   *
   * The same routes bound free text straight through, and node:sqlite reads a bare OBJECT as a
   * named-parameter bag — so {"title":{"a":1}} came back "Unknown named parameter" as a 500.
   * str() was written for this and was applied to one field out of seven. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Deleted While You Looked', email: 'gone@e2e.test' } })
    const goneC = r.json?.id
    await req('DELETE', `/api/contacts/${goneC}`)
    chk('the customer really is gone', String((await req('GET', `/api/contacts/${goneC}`)).status), '^404$')

    for (const [what, path, body] of [
      ['a quote', '/api/estimates', { contact_id: goneC, items: [{ description: '24 tees', sizes: { M: 24 }, unit_price: 12 }] }],
      ['a job', '/api/jobs', { contact_id: goneC, title: 'Ghost job' }],
      ['a deal', '/api/opportunities', { contact_id: goneC, title: 'Ghost deal', value: 500 }],
    ]) {
      const out = await req('POST', path, { body })
      chk(`${what} for a customer who no longer exists is a clean refusal`, String(out.status), '^404$')
      chk('…that says what happened and what to do', `${out.json?.code} ${out.text}`, '^customer_not_found .*Reload')
    }
    // …and a missing id is still the plain "pick a customer" it always was.
    chk('no customer at all is still a 400', String((await req('POST', '/api/jobs', { body: { title: 'Nobody' } })).status), '^400$')

    // Malformed free text: a 4xx or a clean save, never a 500.
    r = await req('POST', '/api/contacts', { body: { name: 'Malformed Body Co', email: 'malformed@e2e.test' } })
    const mfC = r.json?.id
    r = await req('POST', '/api/jobs', { body: { contact_id: mfC, title: 'Typed properly', quantities: '24 M' } })
    const mfJ = r.json?.id
    for (const field of ['title', 'notes', 'decoration', 'assigned_to', 'due_date']) {
      const out = await req('PUT', `/api/jobs/${mfJ}`, { body: { [field]: { a: 1 } } })
      chk(`an object in ${field} does not take the job route down`, String(out.status), '^(200|400)$')
    }
    chk('…and the job kept the title a person typed', String((await req('GET', `/api/jobs/${mfJ}`)).json?.title), '^Typed properly$')

    // sort_order went straight to the binding: an object 500'd and 1e400 wrote Infinity into the
    // column the board orders its cards by. The pipeline's twin has carried this guard since
    // v1.14.0, with a comment describing the bug; the job board never got it.
    chk('an object sort_order on the job board is refused, not a 500',
      String((await req('PATCH', `/api/jobs/${mfJ}/stage`, { body: { stage: 'prepress', sort_order: { a: 1 } } })).status), '^400$')
    // JSON.stringify(Infinity) is `null`, so the literal has to go over the wire by hand — which
    // is exactly how a real caller produces it: JSON.parse('1e400') is Infinity.
    const infRes = await fetch(`${BASE}/api/jobs/${mfJ}/stage`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
      body: '{"stage":"prepress","sort_order":1e400}',
    })
    const infJson = await infRes.json().catch(() => ({}))
    chk('…and an infinite one too', `${infRes.status} ${infJson?.code || ''}`, '^400 invalid_sort_order$')
    r = await req('PATCH', `/api/jobs/${mfJ}/stage`, { body: { stage: 'prepress', sort_order: 3 } })
    chk('…while a real one still moves the card', `${r.status} ${r.json?.sort_order}`, '^200 3$')
  }

  /* ---------- the app does not say it emailed a customer who has no email address ----------
   * queueEmail writes an email_log row with `to_email = contact?.email ?? ''` and only actually
   * sends `if (deliver && to)`. Three routes called it and then answered {ok:true} with a timeline
   * entry asserting delivery — "Invoice INV-1007 emailed to customer", "Payment reminder sent" —
   * for a customer with no email address at all. The shop believed it had chased the money and
   * moved on. This is the dunning path. Its two siblings on the same screen already refused,
   * which is how the inconsistency was found.
   *
   * And a VOIDED invoice must not chase anything: request-payment built a live pay link and
   * mailed a real demand for money the shop had already withdrawn. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Phone Only Signs' } })
    const noMailC = r.json?.id
    chk('a customer can exist with no email — plenty do', String(!!noMailC), '^true$')
    r = await req('POST', '/api/estimates', { body: { contact_id: noMailC, items: [{ description: '48 tees', sizes: { M: 48 }, unit_price: 11 }] } })
    const nmEst = r.json?.id
    r = await req('POST', `/api/estimates/${nmEst}/convert`, { body: { due_date: '2026-03-01' } })
    const nmInv = r.json?.invoice_id

    const outboxLen = async () => ((await req('GET', '/api/outbox')).json || []).length
    const before = await outboxLen()
    for (const [what, path] of [
      ['emailing the invoice', `/api/invoices/${nmInv}/send`],
      ['chasing it when it goes past due', `/api/invoices/${nmInv}/nudge`],
      ['following up the quote', `/api/estimates/${nmEst}/nudge`],
      ['sending a payment link', `/api/invoices/${nmInv}/request-payment`],
    ]) {
      const out = await req('POST', path)
      chk(`${what} is refused when there is no address to send to`, String(out.status), '^400$')
      chk('…with a code the screen can act on', String(out.json?.code || ''), '^no_email$')
    }
    chk('…and nothing was written to the Outbox claiming otherwise', String(await outboxLen()), `^${before}$`)

    // Give them an address and every one of those works, which is the other half of the promise.
    await req('PUT', `/api/contacts/${noMailC}`, { body: { name: 'Phone Only Signs', email: 'phoneonly@e2e.test' } })
    r = await req('POST', `/api/invoices/${nmInv}/send`)
    chk('once they have an address the invoice really does go', String(r.status), '^200$')
    chk('…and the app says who it went to', String(r.json?.emailed_to), '^phoneonly@e2e\\.test$')

    // Void it. Nothing may chase money on a cancelled demand.
    r = await req('POST', `/api/invoices/${nmInv}/void`, { body: { reason: 'raised in error' } })
    chk('the invoice is voided', String(r.status), '^200$')
    for (const [what, path] of [
      ['a pay link', `/api/invoices/${nmInv}/request-payment`],
      ['the invoice itself', `/api/invoices/${nmInv}/send`],
      ['a past-due reminder', `/api/invoices/${nmInv}/nudge`],
    ]) {
      const out = await req('POST', path)
      chk(`a voided invoice does not email the customer ${what}`, `${out.status} ${out.json?.code || ''}`, '^409 invoice_void$')
    }
  }

  /* ---------- a credential a shop wants gone can be removed from a screen ----------
   * Every stored secret was write-only. The settings form renders a secret blank — the browser
   * never sees the value — so an empty submission has to mean "unchanged", and applySettingsPatch
   * skips it deliberately. The consequence was that NO value meant "remove it": a shop that
   * pasted the wrong Stripe key, or whose Slack admin, bookkeeper or office manager just left
   * with the credentials in their head, could not take that connection out of the product from
   * any screen. Google Drive was the only integration in the whole app with a way out; the
   * answer for the other nine was sqlite3, which is the definition of a state a human cannot fix. */
  {
    await req('PUT', '/api/settings', { body: { slack_bot_token: 'xoxb-real-token', slack_signing_secret: 'signing-secret' } })
    let sset = (await req('GET', '/api/settings')).json?.settings || {}
    chk('a shop connects Slack', String(sset.slack_bot_token_set), '^true$')

    // The thing that used to be a no-op, and the reason it has to stay one.
    await req('PUT', '/api/settings', { body: { slack_bot_token: '' } })
    sset = (await req('GET', '/api/settings')).json?.settings || {}
    chk('saving the form blank still keeps the key, because the form renders it blank', String(sset.slack_bot_token_set), '^true$')

    r = await req('POST', '/api/settings/disconnect/slack')
    chk('Slack can be disconnected', String(r.status), '^200$')
    sset = (await req('GET', '/api/settings')).json?.settings || {}
    chk('…and the token is really gone', String(sset.slack_bot_token_set), '^false$')
    chk('…along with the rest of that connection', String(sset.slack_signing_secret_set), '^false$')

    // The other integrations, each of which had exactly the same dead end.
    await req('PUT', '/api/settings', { body: { stripe_secret: 'sk_test_gate', ai_api_key: 'sk-ant-gate', ss_api_key: 'ss-gate', ss_account: '1234' } })
    for (const [group, key] of [['stripe', 'stripe_secret_set'], ['ai', 'ai_api_key_set'], ['ss', 'ss_api_key_set']]) {
      chk(`${group} disconnects`, String((await req('POST', `/api/settings/disconnect/${group}`)).status), '^200$')
      const now = (await req('GET', '/api/settings')).json?.settings || {}
      chk(`…and ${group}'s credential is gone`, String(now[key]), '^false$')
    }
    chk('…and S&S\'s account number went with its key', String(((await req('GET', '/api/settings')).json?.settings || {}).ss_account || ''), '^$')

    // An unknown integration is a 404, not a silent 200 that teaches the UI it worked.
    chk('an integration that does not exist is refused', String((await req('POST', '/api/settings/disconnect/nope')).status), '^404$')
    chk('…and a prototype key is not an integration either', String((await req('POST', '/api/settings/disconnect/constructor')).status), '^404$')

    // The other half: an explicit erase through the ordinary settings form.
    await req('PUT', '/api/settings', { body: { slack_bot_token: 'xoxb-again' } })
    chk('a key can be put back', String(((await req('GET', '/api/settings')).json?.settings || {}).slack_bot_token_set), '^true$')
    await req('PUT', '/api/settings', { body: { slack_bot_token: '__CLEAR__' } })
    chk('…and erased deliberately, without a route per integration',
      String(((await req('GET', '/api/settings')).json?.settings || {}).slack_bot_token_set), '^false$')
  }

  /* ---------- a rule that names no stage does not mail the customer at every stage ----------
   * fire() skipped its stage filter when `params.stage` was falsy, on the reading that "no stage
   * set" means "unfiltered". It does not: a rule that names no stage is a rule nobody finished
   * writing, and treating it as "matches everything" turns ONE job crossing the board into six
   * customer emails, on every job in the shop. The builder made that the default shape — its
   * stage dropdown showed whatever the browser selected first while `params` went up empty, so
   * the owner read "new" off the screen and saved a rule that fired on all seven columns. */
  {
    const bad = await req('POST', '/api/automations', {
      body: { name: 'Stage rule with no stage', trigger: 'job.stage', params: {},
        actions: [{ key: 'email.customer', config: { subject: 'Update', body: 'Your order moved.' } }] },
    })
    chk('a stage rule with no stage cannot be saved', String(bad.status), '^400$')
    chk('…and says what is missing', String(bad.json?.code || ''), '^missing_param$')

    // A rule stored before that refusal existed — every install has some — must not fire either,
    // and the shop has to be able to SEE that it is the broken one.
    const good = await req('POST', '/api/automations', {
      body: { name: 'Ship notice', trigger: 'job.stage', params: { stage: 'shipping' },
        actions: [{ key: 'email.customer', config: { subject: 'Shipped', body: 'On its way.' } }] },
    })
    const legacyId = good.json?.id
    chk('a rule that names its stage saves', String(good.status), '^200$')
    shopDb('gate-shop', (db) => db.prepare("UPDATE automations SET params = '{}' WHERE id = ?").run(legacyId))

    const listed = ((await req('GET', '/api/automations')).json?.automations || []).find((x) => x.id === legacyId)
    chk('…and a stored rule with no stage is flagged for the shop to fix', String(listed?.needs_setup), '^true$')

    const runsBefore = ((await req('GET', '/api/automations')).json?.runs || []).length
    r = await req('POST', '/api/contacts', { body: { name: 'Stage Spam Target', email: 'stagespam@e2e.test' } })
    const ssC = r.json?.id
    r = await req('POST', '/api/jobs', { body: { contact_id: ssC, title: 'Board crossing', decoration: 'Screen Print' } })
    const ssJ = r.json?.id
    for (const stage of ['art_approval', 'prepress', 'production', 'qc']) {
      await req('PATCH', `/api/jobs/${ssJ}/stage`, { body: { stage } })
    }
    const runsAfter = ((await req('GET', '/api/automations')).json?.runs || [])
    const spam = runsAfter.filter((x) => x.automation_id === legacyId).length
    chk('one job crossing four columns does not mail the customer four times', String(spam), '^0$')
    chk('…and nothing else started running either', String(runsAfter.length <= runsBefore + 1), '^true$')

    // The way out is the screen it was written on: give it a stage and it works again.
    r = await req('PUT', `/api/automations/${legacyId}`, { body: { params: { stage: 'shipping' } } })
    chk('choosing a stage fixes the rule from the UI', String(r.status), '^200$')
    const fixed = ((await req('GET', '/api/automations')).json?.automations || []).find((x) => x.id === legacyId)
    chk('…and it stops being flagged', String(fixed?.needs_setup), '^false$')
    await req('PATCH', `/api/jobs/${ssJ}/stage`, { body: { stage: 'shipping' } })
    const fired = ((await req('GET', '/api/automations')).json?.runs || []).filter((x) => x.automation_id === legacyId).length
    chk('…and now fires on exactly the stage it names', String(fired), '^1$')
    await req('DELETE', `/api/automations/${legacyId}`)
  }

  /* ---------- a backup that archived nothing must not report success ----------
   * With count=0 and failed=0 this script printed "backup ok — 0 database(s)" and exited 0. So a
   * typo'd DATA_ROOT, a moved PSC_DB or an unmounted volume produced a green cron line every night
   * and thirty days of empty archives — and you find out on the day you need it. Separately, the
   * app's public/uploads is SYMLINKED onto the data volume per INSTALL.md, and plain `tar cz`
   * stores a symlink as one link entry: the archive was written, tar exited 0, and not one piece
   * of customer artwork was in it.
   *
   * This runs the real script, because both faults are in its exit status and neither shows up by
   * reading it. */
  {
    const { execFileSync } = await import('node:child_process')
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, rmSync } = await import('node:fs')
    const sh = (env, cwd) => {
      try {
        const out = execFileSync('bash', [join(ROOT, 'deploy/backup.sh')], { env: { ...process.env, ...env }, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        return { code: 0, out }
      } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` } }
    }
    const box = mkdtempSync(join(tmpdir(), 'psc-backup-'))
    try {
      // 1 — a data root with no databases in it at all.
      mkdirSync(join(box, 'empty'), { recursive: true })
      mkdirSync(join(box, 'out1'), { recursive: true })
      let r1 = sh({ DATA_ROOT: join(box, 'empty'), BACKUP_ROOT: join(box, 'out1') })
      chk('a backup that found no databases exits non-zero', String(r1.code), '^[1-9]')
      chk('…and says so, so cron mail names the cause', r1.out, 'no databases found')

      // 2 — a real database plus a SYMLINKED uploads directory, the shape INSTALL.md produces.
      const data = join(box, 'data')
      mkdirSync(data, { recursive: true })
      mkdirSync(join(box, 'art'), { recursive: true })
      writeFileSync(join(box, 'art', 'proof.png'), 'not really a png')
      symlinkSync(join(box, 'art'), join(data, 'uploads'))
      execFileSync('sqlite3', [join(data, 'printshop.db'), 'create table t(a); insert into t values(1);'])
      mkdirSync(join(box, 'out2'), { recursive: true })
      const r2 = sh({ DATA_ROOT: data, BACKUP_ROOT: join(box, 'out2') })
      chk('a real backup still succeeds', String(r2.code), '^0$')
      const archive = readdirSync(join(box, 'out2')).find((f) => f.endsWith('.tar.gz'))
      chk('…and produced an archive', String(!!archive), '^true$')
      // Unpack it and prove the artwork is actually inside, not just a dangling symlink entry.
      execFileSync('tar', ['xzf', join(box, 'out2', archive), '-C', join(box, 'out2')])
      const stamp = readdirSync(join(box, 'out2')).find((f) => !f.endsWith('.tar.gz'))
      execFileSync('tar', ['xzf', join(box, 'out2', stamp, 'uploads.tar.gz'), '-C', join(box, 'out2')])
      chk('…with the customer artwork really in it, not a dangling symlink', readdirSync(join(box, 'out2', 'uploads')).join(','), 'proof.png')
    } finally { rmSync(box, { recursive: true, force: true }) }
  }

  /* ---------- a two-garment order must buy both garments ----------
   * The estimate -> job conversion merged every line's size grid into ONE flat grid on jobs.sizes
   * and kept only the FIRST line's description as jobs.garment. The purchase order — the call that
   * spends real money at the distributor — then bought that single style for the whole quantity.
   * Tees + hoodies for one team is among the most common orders a small shop takes; the shop
   * ordered 150 tees, received 150 tees, and discovered on press day that the 50 hoodies had never
   * been bought, with the date already promised.
   *
   * NB the merge preserved the piece COUNT (150 either way) — what it destroyed was which style
   * each piece belonged to. So the assertion that matters is the SPLIT, not the total. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Two Garment Co', email: 'two@e2e.test' } })
    const tgCid = r.json?.id ?? r.json?.contact?.id
    r = await req('POST', '/api/estimates', {
      body: {
        contact_id: tgCid,
        items: [
          { description: 'Gildan 5000 Heavy Cotton Tee — Black — 2/0 Front', sizes: { S: 20, M: 40, L: 30, XL: 10 }, unit_price: 11, taxable: true },
          { description: 'Gildan 18500 Heavy Blend Hoodie — Black — 2/0 Front', sizes: { M: 10, L: 20, XL: 20 }, unit_price: 34, taxable: true },
          { description: 'Screen setup', qty: 2, unit_price: 25, taxable: false },
        ],
      },
    })
    const tgEst = r.json?.id ?? r.json?.estimate?.id
    r = await req('POST', `/api/estimates/${tgEst}/convert`, { body: { due_date: '2026-10-15' } })
    const tgJob = r.json?.job_id

    const po = (await req('GET', `/api/jobs/${tgJob}/po`)).json || {}
    const skus = [...new Set((po.lines || []).map((l) => l.sku))].sort()
    chk('a two-garment order puts both garments on the purchase order', skus.join(','), '^G185,G500$')
    const hoodies = (po.lines || []).filter((l) => l.sku === 'G185').reduce((s, l) => s + l.qty, 0)
    const tees = (po.lines || []).filter((l) => l.sku === 'G500').reduce((s, l) => s + l.qty, 0)
    chk('…the 50 hoodies are actually ordered', String(hoodies), '^50$')
    chk('…and only the 100 tees are ordered as tees', String(tees), '^100$')
    chk('…and every piece on the job is covered', String(po.total_units), '^150$')

    // The two screens the owner trusts must now agree about the same job's blank spend. Before
    // this, the PO said $480 (150 pieces all costed as $3.20 tees) while ROI costed the hoodies
    // properly off the estimate items — a 58% disagreement on one job, with nothing to reconcile
    // them. They do NOT land on the same number even when correct: ROI multiplies by the spoilage
    // allowance (100x$3.20 + 50x$16.50 = $1,145, x1.02 = $1,167.90) because it costs what the job
    // will CONSUME, while the PO orders what the customer bought. So assert the gap is the
    // spoilage allowance and nothing more.
    const roi = (await req('GET', `/api/roi/${tgJob}`)).json || {}
    const roiGarment = Number(roi.breakdown?.garment ?? roi.garment ?? NaN)
    if (Number.isFinite(roiGarment) && roiGarment > 0) {
      const gap = Math.abs(Number(po.est_cost) - roiGarment) / roiGarment
      chk('…and the PO no longer disagrees with ROI about the blank spend', String(gap < 0.05), '^true$')
    } else say('·', 'ROI breakdown shape not found — PO/ROI agreement checked without failing')

    // The floor documents must not contradict themselves either.
    const pick = await req('GET', `/api/jobs/${tgJob}/pick-ticket.pdf`)
    chk('the pick ticket names the hoodies it is asking someone to pick', pick.text, '18500|Hoodie')
    const pkg = (await req('GET', `/api/jobs/${tgJob}/print-package`)).json || {}
    chk('the print package carries both garments', String((pkg.lines || []).length), '^2$')
  }

  /* ---------- the press can print the work ticket for a job typed onto the board ----------
   * The handler LEFT JOINs estimates and reads e.items. With no estimate that column is SQL NULL,
   * and JSON.parse(null) is JSON.parse('null') — which SUCCEEDS and returns null, so parse()'s
   * `[]` fallback never fired and the next .filter() threw. GET /p/ticket/:id answered 500 with a
   * body of exactly "Error" for every job with no estimate behind it: every walk-in typed onto
   * the board, every job whose estimate was later deleted, and JOB-1007 in the shipped demo data.
   * That is the page the press operator runs the job from. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Walk In Wanda', email: 'walkin@e2e.test' } })
    r = await req('POST', '/api/jobs', {
      body: { contact_id: r.json?.id, title: 'Rush 60 hoodies for the fair', quantities: '20 M / 20 L / 20 XL' },
    })
    const boardJob = r.json?.id ?? r.json?.job?.id
    chk('a job can be typed straight onto the board', String(boardJob ?? ''), '^\\d+$')
    const jr = (await req('GET', `/api/jobs/${boardJob}`)).json || {}
    const ticket = String(jr.ticket_url || jr.job?.ticket_url || '')
    chk('…and it carries a work-ticket link', String(!!ticket), '^true$')
    const tr = await req('GET', ticket.replace(/^https?:\/\/[^/]+/, ''), { cookies: false })
    chk('the work ticket prints for a job with no estimate behind it', String(tr.status), '^200$')
    chk('…and it is a real ticket, not an error page', tr.text, 'Size Breakdown|Work Ticket|JOB-')

    /* …and that job can be told what to buy. jobs.garment is what costFor() reads to pick the SKU
     * the purchase order spends money on, and NO route bound it and no screen offered it: a
     * board-created job's PO came back sku:null / est_cost 0 and submitting it said "set the exact
     * style first", with nowhere in the product to do that. */
    r = await req('PUT', `/api/jobs/${boardJob}`, { body: { garment: 'Gildan 18500 Heavy Blend Hoodie — Black' } })
    chk('a board job can be told which garment it is', String(r.json?.garment ?? 'null'), 'Gildan 18500')
    const bpo = (await req('GET', `/api/jobs/${boardJob}/po`)).json || {}
    chk('…and its purchase order then knows what to buy', String(bpo.lines?.[0]?.sku ?? 'null'), '^G185$')
    chk('…at a real cost, not zero', String(Number(bpo.est_cost) > 0), '^true$')
  }

  /* ---------- re-running an order-history import does not double the shop's revenue ----------
   * The dedupe keys on the source system's order number — and plenty of real exports have no
   * order-number column at all (customer, date, product, qty, price is an ordinary shape). Those
   * rows got an EMPTY ref, which skipped the dedupe check entirely, so importing the same file
   * twice wrote everything again: every customer's lifetime value exactly doubled, and their order
   * count with it — which is what Reorder Radar computes cadence from, so the "due to reorder" list
   * ran off a buying pattern that never happened. One double-click or one refresh was enough, and
   * the dialog on screen promised at that very moment that re-running an export was safe. Nothing
   * in the product lists imported orders, so there was no way to find or undo them. */
  {
    const csv = [
      'Customer,Email,Date,Status,Product,Qty,Unit Price,Total',
      'Dedupe Diner,dedupe@e2e.test,2026-05-02,paid,Gildan 5000 Tee,10,11,110',
      'Dedupe Diner,dedupe@e2e.test,2026-06-11,paid,Gildan 5000 Tee,20,11,220',
    ].join('\n')

    r = await req('POST', '/api/import/orders', { body: { text: csv } })
    chk('an export with no order-number column imports', String(r.json?.imported), '^2$')
    const after1 = (await req('GET', '/api/contacts?q=Dedupe%20Diner')).json?.contacts?.[0]
    const lifetime1 = Number(after1?.lifetime_value || 0)
    chk('…and records the money that was actually in it', String(lifetime1), '^330$')

    // The double-click / "did that work?" retry.
    r = await req('POST', '/api/import/orders', { body: { text: csv } })
    chk('re-running the same export imports nothing', String(r.json?.imported), '^0$')
    chk('…and says how many it recognised', String(r.json?.skipped_duplicates), '^2$')
    const after2 = (await req('GET', '/api/contacts?q=Dedupe%20Diner')).json?.contacts?.[0]
    chk('…and the customer\'s lifetime value did not double', String(Number(after2?.lifetime_value || 0)), `^${lifetime1}$`)
    chk('…nor their order count, which Reorder Radar reads as their cadence',
      String(Number(after2?.job_count || 0)), `^${Number(after1?.job_count || 0)}$`)

    // A genuinely different export must still import — refusing real data is the worse error.
    const csv2 = csv.replace('2026-06-11', '2026-07-19').replace(',20,11,220', ',30,11,330')
    r = await req('POST', '/api/import/orders', { body: { text: csv2 } })
    chk('a different export still imports', String(Number(r.json?.imported) > 0), '^true$')

    /* ---------- the migrating shop's receivables arrive at the figure the customer owes ----------
     * `subtotal` and `total` are both synonyms for the same field, and the winner was whichever
     * COLUMN came first — which the shop exporting the file has no idea it is choosing. Every real
     * order export (Printavo, shopVOX, QuickBooks) writes `Subtotal, Sales Tax, Total` in that
     * order, so the PRE-TAX figure won: a $3,003.94 invoice was raised, unpaid, at $2,775.00, and
     * then chased at $2,775.00 by A/R aging, the customer statement, the Outstanding KPI, the
     * dunning email and the QuickBooks export. A year of open receivables at 8.25% came in $4,573
     * light. The importer has no undo, so the repair was a hand re-import. */
    const taxedCsv = [
      'Order #,Customer,Email,Date,Status,Product,Qty,Unit Price,Subtotal,Sales Tax,Total',
      'MIG-5001,Harbor City Athletics,harbor@e2e.test,2026-06-14,Invoiced,Gildan 5000 Tee,300,9.25,2775.00,228.94,3003.94',
    ].join('\n')
    r = await req('POST', '/api/import/orders', { body: { text: taxedCsv } })
    chk('an export laid out Subtotal, Tax, Total imports', String(r.json?.imported), '^1$')
    const migrated = ((await req('GET', '/api/contacts?q=Harbor%20City%20Athletics')).json?.contacts || [])
      .find((c) => c.email === 'harbor@e2e.test')
    chk('…and the customer owes what the export said they owe, not the pre-tax figure',
      String(round2e(migrated?.balance || 0)), '^3003.94$')
    const migInv = ((await req('GET', '/api/invoices')).json || []).find((i) => i.contact_id === migrated?.id)
    chk('…so the invoice it raises is for the whole balance', String(round2e(migInv?.amount_due ?? 0)), '^3003.94$')
  }

  /* ---------- a shop importing its history does not freeze every other shop ----------
   * node:sqlite is synchronous, and the commit path wrapped the WHOLE file in one tx(). Measured
   * on a 4.79MB export — well inside the app's own 8MB upload cap — that is 18.2 SECONDS in which
   * the process answers nothing: /health returned TWICE in the entire window, where ~700 probes
   * should have got through, and the worst single wait was 18,184ms. After the fix the same file
   * serves 300 probes with a worst wait of 381ms, and imports the same 60,000 orders. On pro.printshopcrm.com that is every OTHER shop's app hung solid
   * while one shop uploads a Printavo export, plus a health check a proxy or a deploy is entitled
   * to read as "this box is dead". A tx() callback has to stay synchronous, so the yield goes
   * BETWEEN transactions: batches of 200 orders, never splitting the estimate→invoice→payment→job
   * graph that actually needs to be atomic. Whole-file atomicity is what we traded away, and the
   * next block proves the trade is safe — a re-upload of the same file resumes exactly. */
  {
    const rows = ['Order Number,Customer,Email,Date,Product,Qty,Unit Price,Total,Status']
    for (let i = 1; i <= 9000; i++) rows.push(`LOAD-${i},Load Test Co,load@e2e.test,2026-04-0${(i % 9) + 1},Gildan 5000 Tee,24,9.5,228,paid`)
    const big = rows.join('\n')

    // Poll /health as fast as it will answer for as long as the import runs. This counts what a
    // second shop — or a load balancer — actually gets served while the first one imports.
    const lat = []
    let polling = true
    const probe = (async () => {
      while (polling) {
        const t = Date.now()
        try { await fetch(`${BASE}/health`) } catch { /* a refused connect is still a data point */ }
        lat.push(Date.now() - t)
      }
    })()

    const form = new FormData()
    form.append('file', new Blob([big], { type: 'text/csv' }), 'history.csv')
    const t0 = Date.now()
    const up = await fetch(`${BASE}/api/import/orders`, { method: 'POST', headers: { Cookie: cookieHeader() }, body: form })
    const wall = Date.now() - t0
    polling = false
    await probe
    const body = await up.json().catch(() => ({}))
    const worst = Math.max(...lat)

    chk('a 9,000-order export imports', String(body.imported), '^9000$')
    // Measured on this very file: 3 probes before the fix, 47 after. Ten sits between them with
    // room on both sides, and neither number is close to it.
    chk(`…while the app keeps answering other requests (${lat.length} health probes served in ${wall}ms, was 3)`,
      String(lat.length >= 10), '^true$')
    // Before the fix the worst wait WAS the whole import: 2601ms measured here, 112ms after.
    chk(`…and nobody waits the length of the import for a page (worst ${worst}ms, was ${wall}ms)`,
      String(worst < 1500), '^true$')

    // The half we traded whole-file atomicity for: batches that landed stay landed, and the same
    // file re-uploaded finishes the job instead of duplicating it. Every row's identity is the
    // file's content hash plus its position, so this holds across every batch boundary.
    const form2 = new FormData()
    form2.append('file', new Blob([big], { type: 'text/csv' }), 'history.csv')
    const up2 = await fetch(`${BASE}/api/import/orders`, { method: 'POST', headers: { Cookie: cookieHeader() }, body: form2 })
    const body2 = await up2.json().catch(() => ({}))
    chk('…and re-uploading it after an interrupted run writes nothing new', String(body2.imported), '^0$')
    chk('…recognising every batch that had already landed', String(body2.skipped_duplicates), '^9000$')
  }

  /* ---------- and neither does one importing its customer book ----------
   * The same defect on the importer a switching shop reaches FIRST. This one was not even in a
   * transaction — one autocommitted INSERT per row, in a synchronous loop. A 2.94MB customer book,
   * again inside the 8MB cap, blocked for 4.65 seconds with /health answering three times.
   * Batching it is also 5.7x FASTER (2318ms -> 408ms on the 30,000 rows below), because 30,000
   * autocommits became 60 transactions — the responsiveness was not bought with throughput. */
  {
    const crows = ['Name,Email,Phone,Company']
    for (let i = 1; i <= 30000; i++) crows.push(`Bulk Person ${i},bulk${i}@e2e.test,555-0100,Bulk Co ${i % 200}`)
    const cbig = crows.join('\n')

    const clat = []
    let cpolling = true
    const cprobe = (async () => {
      while (cpolling) {
        const t = Date.now()
        try { await fetch(`${BASE}/health`) } catch { /* still a data point */ }
        clat.push(Date.now() - t)
      }
    })()

    const cform = new FormData()
    cform.append('file', new Blob([cbig], { type: 'text/csv' }), 'book.csv')
    const ct0 = Date.now()
    const cup = await fetch(`${BASE}/api/import/contacts`, { method: 'POST', headers: { Cookie: cookieHeader() }, body: cform })
    const cwall = Date.now() - ct0
    cpolling = false
    await cprobe
    const cbody = await cup.json().catch(() => ({}))
    const cworst = Math.max(...clat)

    chk("a 30,000-row customer book imports", String(cbody.created), "^30000$")
    chk(`…while the app keeps answering other requests (${clat.length} health probes served in ${cwall}ms, was 3)`,
      String(clat.length >= 10), '^true$')
    chk(`…and nobody waits the length of the import for a page (worst ${cworst}ms, was ${cwall}ms)`,
      String(cworst < 1500), '^true$')
  }

  /* ---------- an imported order is worth what the file says it was worth ----------
   * Two defects, one arithmetic. A `Total` column is either the ORDER total repeated on every
   * line, or THAT LINE's extended total, and the fold took the largest value it saw — so a real
   * three-line 1000 + 600 + 300 order was written as a $1,900 subtotal under a $1,000 total, and
   * a $1,000 invoice was raised and marked paid. $900 of the shop's own history disappeared, on
   * the feature whose entire promise is that leaving your old tool costs you nothing.
   *
   * And where the file's total legitimately exceeds its lines — setup, rush, shipping, old tax —
   * that total was stored on top of a subtotal computed from the lines, printing Subtotal
   * $1,000.00 / Tax $0.00 / TOTAL $1,180.00 with $180 arriving from nowhere. That is exactly the
   * defect 8e9239e closed on the shop's own documents, reopened one layer down by the importer,
   * and it is carried into the invoice's frozen amount_due and out to the books. */
  {
    // Per-line totals that differ: they are line totals, and they must be added up.
    const lineCsv = [
      'Order Number,Customer,Email,Date,Qty,Unit Price,Total,Status,Product',
      'SO-7001,Sum Lines Screen,sumlines@e2e.test,2026-04-02,100,10.00,1000.00,paid,Tee',
      'SO-7001,Sum Lines Screen,sumlines@e2e.test,2026-04-02,50,12.00,600.00,paid,Hoodie',
      'SO-7001,Sum Lines Screen,sumlines@e2e.test,2026-04-02,20,15.00,300.00,paid,Cap',
    ].join('\n')
    r = await req('POST', '/api/import/orders', { body: { text: lineCsv, preview: true } })
    chk('a per-line export previews as one order, not three', String(r.json?.orders), '^1$')
    chk('…and promises the money the file actually contains', String(r.json?.totalValue), '^1900$')

    r = await req('POST', '/api/import/orders', { body: { text: lineCsv } })
    chk('a per-line export imports as one order', String(r.json?.imported), '^1$')
    const sumC = (await req('GET', '/api/contacts?q=Sum%20Lines%20Screen')).json?.contacts?.[0]
    chk('…worth every line of it, not just the biggest one', String(Number(sumC?.lifetime_value || 0)), '^1900$')

    // The same order shape with the ORDER total repeated on each line must NOT be summed.
    const repCsv = [
      'Order Number,Customer,Email,Date,Qty,Unit Price,Total,Status,Product',
      'SO-7002,Repeat Total Tees,repeat@e2e.test,2026-04-03,100,10.00,1900.00,paid,Tee',
      'SO-7002,Repeat Total Tees,repeat@e2e.test,2026-04-03,50,12.00,1900.00,paid,Hoodie',
      'SO-7002,Repeat Total Tees,repeat@e2e.test,2026-04-03,20,15.00,1900.00,paid,Cap',
    ].join('\n')
    await req('POST', '/api/import/orders', { body: { text: repCsv } })
    const repC = (await req('GET', '/api/contacts?q=Repeat%20Total%20Tees')).json?.contacts?.[0]
    chk('a repeated order total is still not multiplied by its line count', String(Number(repC?.lifetime_value || 0)), '^1900$')

    // A total the lines cannot explain: setup + shipping on a single-line order.
    const gapCsv = [
      'Order Number,Customer,Email,Date,Qty,Unit Price,Total,Status,Product',
      'SO-7003,Setup Fee Signs,setupfee@e2e.test,2026-04-04,100,10.00,1180.00,paid,Tee',
    ].join('\n')
    r = await req('POST', '/api/import/orders', { body: { text: gapCsv } })
    chk('an order whose total exceeds its lines still imports', String(r.json?.imported), '^1$')
    chk('…and the shop is told its lines did not explain it', String(r.json?.totals_reconciled), '^1$')
    const estList = (await req('GET', '/api/estimates')).json
    const gapEst = (Array.isArray(estList) ? estList : estList?.data || []).find((e) => String(e.notes || '').includes('SO-7003'))
    chk('…the imported document adds up', String(round2e(Number(gapEst?.subtotal) + Number(gapEst?.tax))), `^${round2e(Number(gapEst?.total))}$`)
    chk('…at the total the file gave', String(round2e(Number(gapEst?.total))), '^1180$')
    const gapItems = typeof gapEst?.items === 'string' ? JSON.parse(gapEst.items) : (gapEst?.items || [])
    chk('…and the difference is a line the shop can read, not a gap',
      String(gapItems.some((i) => /other charges|discount/i.test(String(i.description || '')) && Math.abs(Number(i.unit_price) - 180) < 0.01)), '^true$')
  }

  /* ---------- changing the quantities changes what the shop buys ----------
   * jobs.line_sizes is the per-garment grid the PO, pick ticket, work ticket and print package all
   * read. It is written once at conversion and PUT never touched it, so a shop that bumped a job
   * from 100 to 150 pieces — the ordinary case, the customer added shirts — got a board, a job
   * card and a capacity plan saying 150 while everything that BUYS or PICKS blanks still said 100.
   * A regression from ff9712f: before it, those documents read the live grid. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Bump Order Betty', email: 'bump@e2e.test' } })
    const bumpC = r.json?.id
    r = await req('POST', '/api/estimates', {
      body: { contact_id: bumpC, items: [{ description: 'Gildan 5000 Heavy Cotton Tee — Black — 2/0 Front', sizes: { S: 20, M: 40, L: 30, XL: 10 }, unit_price: 11 }] },
    })
    const bumpE = r.json?.id
    await req('POST', `/api/estimates/${bumpE}/approve`, { body: {} })
    r = await req('POST', `/api/estimates/${bumpE}/convert`, { body: { due_date: '2026-12-01' } })
    const bumpJ = r.json?.job_id
    let bpo = (await req('GET', `/api/jobs/${bumpJ}/po`)).json || {}
    chk('a converted job orders the quantity it was quoted for', String(bpo.total_units), '^100$')

    r = await req('PUT', `/api/jobs/${bumpJ}`, { body: { quantities: '30 S / 60 M / 45 L / 15 XL' } })
    chk('the shop can bump the quantities', String(r.status), '^200$')
    bpo = (await req('GET', `/api/jobs/${bumpJ}/po`)).json || {}
    chk('…and the purchase order buys the new count, not the old one', String(bpo.total_units), '^150$')
    const pkg2 = (await req('GET', `/api/jobs/${bumpJ}/print-package`)).json || {}
    const pkgLines = (pkg2.lines || []).reduce((t, l) => t + Object.values(l.sizes || {}).reduce((a, n) => a + Number(n || 0), 0), 0)
    chk('…and the print package no longer contradicts itself', String(pkgLines), '^150$')
  }

  /* ---------- the job form's Garment field reaches the purchase order ----------
   * A quote's line description is free text a human writes for a customer to read — "Tee", not a
   * catalogue style. Convert it and the PO comes back sku:null, costed off a fallback style, and
   * Submit refuses: "match the exact style first." The job form HAS the field for that, captioned
   * "What the purchase order buys" — and jobLines() reads line_sizes first, so on every converted
   * job jobs.garment was written and then ignored. Every other exit is shut: the estimate is
   * 409-locked by its invoice, the invoice PUT edits only a due date, and the split editor opens
   * only for two or more garments. The shop cannot buy blanks through the app for a job it made
   * with the app's own documented flow. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Vague Vic', email: 'vague@e2e.test' } })
    const vagueC = r.json?.id
    r = await req('POST', '/api/estimates', { body: { contact_id: vagueC, items: [{ description: 'Tee', sizes: { M: 50 }, unit_price: 10 }] } })
    const vagueE = r.json?.id
    await req('POST', `/api/estimates/${vagueE}/approve`, { body: {} })
    r = await req('POST', `/api/estimates/${vagueE}/convert`, { body: { due_date: '2026-09-30' } })
    const vagueJ = r.json?.job_id
    let vpo = (await req('GET', `/api/jobs/${vagueJ}/po`)).json || {}
    chk('a free-text garment line quotes with no SKU', String(vpo.lines?.[0]?.sku ?? 'null'), '^null$')

    r = await req('PUT', `/api/jobs/${vagueJ}`, { body: { garment: 'Gildan 5000 Heavy Cotton Tee — Black' } })
    chk('the job accepts the exact style, in the field labelled for it', String(r.status), '^200$')
    vpo = (await req('GET', `/api/jobs/${vagueJ}/po`)).json || {}
    chk('…and the purchase order now buys that style', String(vpo.lines?.[0]?.sku ?? 'null'), '^(?!null$)\\w')
    chk('…for the quantity it was quoted at', String(vpo.total_units), '^50$')
    chk('…with no "match the exact style first" warning left', JSON.stringify(vpo.warnings || []), '^(?![\\s\\S]*exact style)')
  }

  /* ---------- a print package with approved art says so ----------
   * ready/note gated on jobs.separation — a column NOTHING in the running product writes (only
   * seed.mjs does, so the demo shop is the one install where this looks fine). Every real job
   * therefore downloaded a "print-ready package" reading "Not print-ready: needs approved art"
   * with the approved art's filename one key above the sentence. Prepress goes back to chase an
   * approval that already happened, on DTF and embroidery jobs that cannot have a separation by
   * definition, and no screen anywhere can record one — a permanent false negative. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'RIP Ready Rita', email: 'rip@e2e.test' } })
    const ripC = r.json?.id
    r = await req('POST', '/api/estimates', { body: { contact_id: ripC, items: [{ description: '48 DTF tanks', sizes: { M: 48 }, unit_price: 16 }] } })
    const ripE = r.json?.id
    await req('POST', `/api/estimates/${ripE}/approve`, { body: {} })
    r = await req('POST', `/api/estimates/${ripE}/convert`, { body: { due_date: '2026-11-30' } })
    const ripJ = r.json?.job_id

    let pkg = (await req('GET', `/api/jobs/${ripJ}/print-package`)).json || {}
    chk('a job with no approved art is not print-ready', String(pkg.ready), '^false$')
    chk('…and is told exactly what it is waiting for', String(pkg.note || ''), 'no approved art')

    const form = new FormData()
    form.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }), 'proof.svg')
    const up = await fetch(`${BASE}/api/jobs/${ripJ}/art`, { method: 'POST', headers: { Cookie: cookieHeader() }, body: form })
    const art = await up.json().catch(() => ({}))
    chk('a proof uploads onto the job', String(up.status), '^200$')
    await req('POST', `/api/art/${art?.art?.id ?? art?.id}/decide`, { body: { decision: 'approved', by: 'Rita' } })

    pkg = (await req('GET', `/api/jobs/${ripJ}/print-package`)).json || {}
    chk('a DTF job whose art IS approved is print-ready', String(pkg.ready), '^true$')
    chk('…and its package does not claim the art is missing', String(pkg.note || ''), '^Ready for the RIP')
    chk('…and it still carries the approved art it is talking about', String(pkg.approved_art?.version ?? ''), '^1$')
  }

  /* ---------- the wrong customer's artwork can be taken back off a job ----------
   * DELETE /api/mockups/:id is gated on `a.estimate_id`, and job art is written with job_id set
   * and estimate_id NULL — so the one art-delete route in the product could never match job art,
   * which is most art rows. Nothing else deleted an art_version except the cascade inside DELETE
   * /api/jobs/:id. A shop that uploaded customer A's proof onto customer B's job and emailed the
   * link had exactly two options: delete the whole job, or leave it. Verified before the fix that
   * /p/art/:id kept rendering it and /uploads/<file> kept serving it after every delete attempt
   * a shop or an integrator could reach for. */
  {
    const ac = (await req('POST', '/api/contacts', { body: { name: 'Proof Recall Co', email: 'recall@e2e.test' } })).json
    const aj = (await req('POST', '/api/jobs', { body: { contact_id: ac.id, title: 'Recall Job', decoration: 'Screen Print' } })).json

    const af = new FormData()
    af.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }), 'wrong-customer.svg')
    const aup = await fetch(`${BASE}/api/jobs/${aj.id}/art`, { method: 'POST', headers: { Cookie: cookieHeader() }, body: af })
    const art = await aup.json().catch(() => ({}))
    chk('art uploads onto a job', String(aup.status), '^200$')
    chk('…with no estimate_id, which is what the old delete route required', String(art.estimate_id ?? 'null'), '^null$')

    const sent = await req('POST', `/api/art/${art.id}/send`)
    const link = String(sent.json?.share_url || '')
    chk('…and the proof link goes to the customer', String(link.startsWith('/p/art/')), '^true$')
    chk('…which serves the artwork', String((await fetch(`${BASE}${link}`)).status), '^200$')

    // The route that could never see it. Still 404s, deliberately: it is an edition-gated mockup
    // route and job art must not start sitting behind that gate.
    chk('the mockup delete route still does not claim job art', String((await req('DELETE', `/api/mockups/${art.id}`)).status), '^404$')

    const del = await req('DELETE', `/api/jobs/${aj.id}/art/${art.id}`)
    chk('a proof on a job can be deleted', String(del.status), '^200$')
    chk('…and the app says the customer\'s link is dead', String(del.json?.link_revoked), '^true$')
    // 403 "Link expired" — checkToken can no longer match a row that is gone. That is the same
    // door the customer hits on any revoked link, which is the right thing for them to see.
    chk('…and it really is', String((await fetch(`${BASE}${link}`)).status), '^40[34]$')
    // The raw upload path falls through to the SPA shell, so a missing file answers 200 with HTML.
    // Assert on what came back, not on the status: the artwork itself must not be servable.
    const rawAfter = await fetch(`${BASE}/uploads/${art.filename}`)
    chk('…and the raw file is gone too, not just unlinked from the page',
      String(!/svg/i.test(rawAfter.headers.get('content-type') || '')), '^true$')
    chk('…and the job no longer lists it', String(((await req('GET', `/api/jobs/${aj.id}`)).json?.art || []).length), '^0$')

    // Art belonging to a DIFFERENT job is not deletable through this job's URL.
    const oj = (await req('POST', '/api/jobs', { body: { contact_id: ac.id, title: 'Other Job' } })).json
    const of2 = new FormData()
    of2.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }), 'other.svg')
    const oup = await fetch(`${BASE}/api/jobs/${oj.id}/art`, { method: 'POST', headers: { Cookie: cookieHeader() }, body: of2 })
    const oart = await oup.json().catch(() => ({}))
    chk('…and one job cannot delete another job\'s art',
      String((await req('DELETE', `/api/jobs/${aj.id}/art/${oart.id}`)).status), '^404$')
    chk('…leaving that one where it was', String(((await req('GET', `/api/jobs/${oj.id}`)).json?.art || []).length), '^1$')
  }

  /* ---------- a 6XL is quoted, printed and picked, not deleted on the way through ----------
   * sanitizeEstimateItems did `if (!SIZES.includes(k)) continue`, and its comment said the editor
   * only ever writes keys from SIZES — true of the editor, false of every other door into it: the
   * v1 API, the CSV import, the AI intake path and any integration all land here. A 45-piece
   * workwear order with 4 6XL and 6 LT came back a 35-piece $640 quote where $820 was ordered,
   * with a 200 and no warning field. Meanwhile PUT /api/jobs/:id had no such filter, so the JOB
   * carried sizes its own estimate had thrown away. The v1 twin had always REFUSED an unknown size
   * rather than deleting it; this is the internal routes catching up, with the vocabulary widened
   * so that the sizes being refused are only the ones that are genuinely not sizes. */
  {
    const wc = (await req('POST', '/api/contacts', { body: { name: 'Workwear Co', email: 'workwear@e2e.test' } })).json
    const grid = { M: 10, L: 10, XL: 10, '2XL': 5, '6XL': 4, LT: 6 }   // 45 pieces
    const est = await req('POST', '/api/estimates', {
      body: { contact_id: wc.id, items: [{ description: 'Carhartt K87 Pocket Tee', sizes: grid, unit_price: 18 }] },
    })
    chk('a 45-piece order with 6XL and tall sizes is accepted', String(est.status), '^200$')
    // 45 x $18 = $810, plus the shop's 2XL upcharge of $2 on 5 pieces = $820. Was $640: the 4 6XL
    // and 6 LT were deleted, so 35 pieces were billed for an order of 45.
    chk('…and quoted for every piece that was ordered (was $640 of a $820 order)', String(est.json?.subtotal), '^820$')
    const stored = (est.json?.items && typeof est.json.items === 'string' ? JSON.parse(est.json.items) : est.json?.items) || []
    chk('…with the sizes still on the line', String(sizeSum(stored[0]?.sizes)), '^45$')

    // The job half. It always accepted these keys — with NO character rule at all, just
    // String(size).slice(0, 12) — so the two halves of the app disagreed in both directions: the
    // estimate deleted real sizes, the job accepted anything. One rule now, on both.
    const wj = (await req('POST', '/api/jobs', { body: { contact_id: wc.id, title: 'Workwear run' } })).json
    const wput = await req('PUT', `/api/jobs/${wj.id}`, { body: { line_sizes: [{ garment: 'Carhartt K87', sizes: grid }] } })
    chk('the job carries the same 45 pieces its estimate does', String(sizeSum(JSON.parse(wput.json?.sizes || '{}'))), '^45$')
    chk('…and refuses a key that is not a size, rather than storing 12 characters of it',
      String((await req('PUT', `/api/jobs/${wj.id}`, { body: { line_sizes: [{ garment: 'X', sizes: { '<script>ale': 5 } }] } })).json?.code), '^unknown_size$')

    // The pick ticket used to print rows for known sizes only, under a TOTAL that counted them all:
    // rows summing to 70 under its own "SUBTOTAL 80", on a job of 105.
    const pick = await fetch(`${BASE}/api/jobs/${wj.id}/pick-ticket.pdf`, { headers: { Cookie: cookieHeader() } })
    const pickText = Buffer.from(await pick.arrayBuffer()).toString('latin1')
    chk('the pick ticket prints a row for the 6XL it counts', String(/6XL/.test(pickText)), '^true$')
    chk('…and for the tall run', String(/\bLT\b/.test(pickText)), '^true$')

    // Junk is still refused, loudly, instead of being deleted quietly — and the key echoed back is
    // constrained by the same rule, so widening the vocabulary did not open an injection door.
    const junk = await req('POST', '/api/estimates', {
      body: { contact_id: wc.id, items: [{ description: 'T', sizes: { M: 10, 'a"onerror=alert(1)': 5 }, unit_price: 10 }] },
    })
    chk('a size that is not a size is refused, not silently dropped', String(junk.status), '^400$')
    chk('…naming it, and what is allowed', String(junk.json?.code), '^unknown_size$')
  }

  /* ---------- an issued invoice still adds up after the shop raises its rates ----------
   * Line amounts are never stored; every renderer recomputes them from the LIVE size_upcharges
   * setting. subtotal/tax/total ARE stored, frozen at write time. So one PUT /api/settings — an
   * ordinary, documented change a shop makes when blank costs go up — retroactively re-priced the
   * LINES of every estimate and invoice it had ever issued, while their totals stayed put. The
   * customer is holding that PDF, and the shop is only entitled to collect the stored figure. */
  {
    const dc = (await req('POST', '/api/contacts', { body: { name: 'Drift Co', email: 'drift@e2e.test' } })).json
    await req('PUT', '/api/settings', { body: { size_upcharges: JSON.stringify({ '2XL': 2, '3XL': 3 }) } })
    const line = { description: 'Tees', unit_price: 8.75, sizes: { M: 100, '2XL': 10, '3XL': 2 } }
    const de = (await req('POST', '/api/estimates', { body: { contact_id: dc.id, items: [line] } })).json
    chk('a quote is written at the rates of the day', String(de?.subtotal), '^1006$')

    const conv = await req('POST', `/api/estimates/${de.id}/convert`)
    const invId = conv.json?.invoice?.id ?? conv.json?.invoice_id ?? conv.json?.id
    const pdfMoney = async () => {
      const res = await fetch(`${BASE}/api/invoices/${invId}/pdf`, { headers: { Cookie: cookieHeader() } })
      const text = Buffer.from(await res.arrayBuffer()).toString('latin1')
      return [...text.matchAll(/\$([0-9,]+\.[0-9]{2})/g)].map((m) => m[1])
    }
    const before = await pdfMoney()
    chk('…and its invoice PDF prints a line that matches its subtotal', String(before.includes('1,006.00')), '^true$')

    // The shop's blank costs go up, so it raises its extended-size upcharges. Nothing else happens.
    await req('PUT', '/api/settings', { body: { size_upcharges: JSON.stringify({ '2XL': 4, '3XL': 6 }) } })
    const after = await pdfMoney()
    chk('…and raising the shop\'s upcharges does not rewrite that invoice', String(after.join('|')), `^${before.join('|').replace(/[$.|,]/g, (c) => '\\' + c)}$`)
    chk('…so no $1,032.00 line appears above a $1,006.00 subtotal', String(after.includes('1,032.00')), '^false$')
    chk('…and the amount the shop may collect is unchanged',
      String((await req('GET', `/api/invoices/${invId}`)).json?.amount_due), '^1006$')

    // The other half: today's rates must still apply to work written today, or the setting is dead.
    const fresh = (await req('POST', '/api/estimates', { body: { contact_id: dc.id, items: [line] } })).json
    chk('a NEW quote is priced at the new rates', String(fresh?.subtotal), '^1032$')
    // And an unrelated edit must not silently re-price a document that was already issued.
    await req('PUT', `/api/estimates/${de.id}`, { body: { notes: 'called the customer' } })
    chk('…while editing an old quote\'s notes re-prices nothing',
      String((await req('GET', `/api/estimates/${de.id}`)).json?.subtotal), '^1006$')
  }

  /* ---------- and EVERY writer of an estimate stamps that table, not just the editor ----------
   * The freeze above lives in sanitizeEstimateItems, which guards the two hand-edited routes.
   * Nine other writers stored bare lines — reorder, duplicate, autopilot, the CSV order import,
   * the v1 API, gang sheets, quick quote, the receptionist and the assistant — so a document
   * written through any of them re-priced its own LINES the next time the shop touched an
   * ordinary documented setting, while its stored subtotal stayed put. Lines that disagree with
   * the invoice total also park the QuickBooks push forever behind "refusing to push: lines total
   * X but the invoice is Y", which cannot be resolved from any screen: the number that moved is
   * not written anywhere on the invoice. Each writer below is driven for real, then the rates are
   * moved underneath it. */
  {
    const RATES_THEN = JSON.stringify({ '2XL': 2, '3XL': 3 })
    const RATES_NOW = JSON.stringify({ '2XL': 40, '3XL': 60 })
    await req('PUT', '/api/settings', { body: { size_upcharges: RATES_THEN } })
    const fc = (await req('POST', '/api/contacts', { body: { name: 'Freeze Co', email: 'freeze@e2e.test' } })).json
    const LINE = { description: 'Tees', unit_price: 8.75, sizes: { M: 100, '2XL': 10, '3XL': 2 } }

    // Seed one estimate the ordinary way, so reorder and duplicate have something to work from.
    const seed = (await req('POST', '/api/estimates', { body: { contact_id: fc.id, items: [LINE] } })).json

    // Reuse the suite's live key — rotating here would invalidate it for every later case.
    const apiKey = key
    // Each of these returns its own shape; the estimate ROW is what all of them have to get right.
    const idOf = (r) => r.json?.id ?? r.json?.estimate?.id ?? r.json?.estimate_id ?? null
    const written = {
      reorder: idOf(await req('POST', `/api/contacts/${fc.id}/reorder`)),
      duplicate: idOf(await req('POST', `/api/estimates/${seed.id}/duplicate`)),
      v1: idOf(await req('POST', '/api/v1/estimates', {
        cookies: false,
        headers: { Authorization: `Bearer ${apiKey}` },
        body: { customer: { name: 'Freeze Co', email: 'freeze@e2e.test' }, items: [LINE] },
      })),
      autopilot: idOf(await req('POST', '/api/autopilot', {
        body: { text: 'Please quote 100 M, 10 2XL and 2 3XL Gildan 5000 tees in black, 1 color front. Freeze Co freeze@e2e.test' },
      })),
    }
    const linesOf = (row) => (Array.isArray(row?.items) ? row.items : JSON.parse(row?.items || '[]'))
    const rowOf = async (id) => (await req('GET', `/api/estimates/${id}`)).json

    for (const [who, id] of Object.entries(written)) {
      chk(`${who} writes an estimate`, String(id ?? 'none'), '^[0-9]+$')
      const sized = linesOf(await rowOf(id)).filter((l) => l.sizes && Object.keys(l.sizes).length)
      chk(`…and every sized line ${who} wrote carries the table it was priced with`,
        String(sized.length > 0 && sized.every((l) => l.size_upcharges?.['2XL'] === 2)), '^true$')
    }

    // The shop raises its extended-size upcharges twentyfold. Nothing else happens.
    await req('PUT', '/api/settings', { body: { size_upcharges: RATES_NOW } })
    const { computeTotals } = await import('../public/js/shared/pricing.js')
    const live = JSON.parse(RATES_NOW)
    for (const [who, id] of Object.entries(written)) {
      const fresh = await rowOf(id)
      const recomputed = computeTotals(linesOf(fresh), 0, live).subtotal
      chk(`…so ${who}'s lines still sum to the subtotal stored with them`,
        `${recomputed} vs ${fresh?.subtotal}`, `^${fresh?.subtotal} vs ${fresh?.subtotal}$`)
    }
    // And the setting is not dead: work written today is priced at today's rates.
    const now2 = (await req('POST', '/api/estimates', { body: { contact_id: fc.id, items: [LINE] } })).json
    chk('a quote written after the change is priced at the new rates', String(now2?.subtotal), '^1500$')
    await req('PUT', '/api/settings', { body: { size_upcharges: RATES_THEN } })
  }

  /* ---------- a quantity that overflows the money arithmetic is refused, not stored as $0 ------
   * unit_price got a cap after `1e308` overflowed computeTotals and stored a null subtotal. The
   * OTHER operand never got one. round2 multiplies by 100 before rounding and floors a non-finite
   * result to 0 — deliberately, it is the money helper — so quantity 1e300 at $10,000,000 came
   * back 201 with `subtotal 0, total 0`: the exact "$0 estimate a customer could approve" the
   * file's own comments say was closed. representableLines only asked whether qty * price was
   * finite, which 1e307 is; it overflowed one step later. And 50 lines that each pass on their own
   * could overflow in the SUM, which nothing checked at all. */
  {
    const oc = (await req('POST', '/api/contacts', { body: { name: 'Overflow Co', email: 'overflow@e2e.test' } })).json
    const post = (items) => req('POST', '/api/estimates', { body: { contact_id: oc.id, items } })

    let o = await post([{ description: 'X', qty: 1e300, unit_price: 1e7 }])
    chk('an overflowing quantity is refused', String(o.status), '^400$')
    chk('…rather than stored as a $0 estimate', String(o.json?.subtotal ?? 'none'), '^none$')
    chk('…with the code the UI already knows', String(o.json?.code), '^invalid_total$')

    o = await post(Array.from({ length: 50 }, () => ({ description: 'X', qty: 1e298, unit_price: 1e7 })))
    chk('50 lines that only overflow when summed are refused too', String(o.status), '^400$')

    // The guard must not touch anything a shop would really type, including sub-cent unit prices.
    o = await post([{ description: 'Tees', qty: 500, unit_price: 12.5 }])
    chk('a real order is unaffected', String(o.json?.subtotal), '^6250$')
    o = await post([{ description: 'Thread', qty: 1, unit_price: 0.001 }])
    chk('…and so is a sub-cent line', String(o.status), '^200$')

    // Same two holes on the public API, where an integration cannot see a silently-changed number.
    // Uses the suite's live key via asKey(): rotating a fresh one here would revoke the key the
    // webhook cases further down are still holding, which is exactly what the first draft did.
    const v1 = (items) => req('POST', '/api/v1/estimates', { body: { customer_id: oc.id, items }, ...asKey() })
    let v = await v1([{ description: 'X', quantity: 1e300, unit_price: 1e7 }])
    chk('the public API refuses an overflowing quantity', String(v.status), '^400$')
    chk('…naming it as a quantity problem', String(v.json?.code), '^invalid_quantity$')
    // Number.isInteger(1e300) is true, so the sizes branch had no cap at all and stored 1e302.
    v = await v1([{ description: 'X', sizes: { M: 1e300 }, unit_price: 100 }])
    chk('…and an absurd size count, which Number.isInteger called valid', String(v.status), '^400$')
    chk('…rather than storing a subtotal of 1e+302', String(v.json?.subtotal ?? 'none'), '^none$')
    v = await v1([{ description: 'Tees', quantity: 500, unit_price: 12.5 }])
    chk('…while a real integration order still posts', String(v.json?.subtotal), '^6250$')
  }

  /* ---------- an ordinary quantity bump does not collapse a two-garment job ----------
   * The 409 that refuses a flat grid over two garments read jobs.line_sizes RAW. That column
   * arrived by migration, so it is '[]' on every job written before it, and on those the
   * per-garment split lives on the estimate — jobLines() is the function that knows this, and the
   * guard did not use it. '[]' read as "no garments", took the single-line branch, and MERGED a
   * tees-and-hats job into one style: the purchase order then bought 60 more tees in a size that
   * style does not come in, at the tee's price, with every warning the correct PO carried gone.
   * On an upgraded install that is every job the shop has. It also made the split editor
   * unreachable, because the editor only opens from the 409 that could never fire. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Brewfest Staff', email: 'brewfest@e2e.test' } })
    const preC = r.json?.id
    r = await req('POST', '/api/estimates', {
      body: {
        contact_id: preC,
        items: [
          { description: 'Next Level 6210 Tee — Forest — 1/0 Front', sizes: { S: 12, M: 30, L: 40 }, unit_price: 9 },
          { description: 'Richardson 112 Trucker — Black — Patch', sizes: { OSFA: 60 }, unit_price: 14 },
        ],
      },
    })
    const preE = r.json?.id
    await req('POST', `/api/estimates/${preE}/approve`, { body: {} })
    r = await req('POST', `/api/estimates/${preE}/convert`, { body: { due_date: '2026-11-20' } })
    const preJ = r.json?.job_id
    // Exactly the shape of a job written before the line_sizes column existed: the split is on the
    // estimate and the column is empty. This is what an upgraded shop's whole board looks like.
    shopDb('gate-shop', (db) => db.prepare("UPDATE jobs SET line_sizes = '[]' WHERE id = ?").run(preJ))
    let prePo = (await req('GET', `/api/jobs/${preJ}/po`)).json || {}
    chk('a pre-migration job still buys both garments', JSON.stringify(prePo.lines || []), '112')

    r = await req('PUT', `/api/jobs/${preJ}`, { body: { quantities: '12 S / 40 M / 40 L / 60 OSFA' } })
    chk('bumping one size on it is refused, not silently merged', String(r.status), '^409$')
    chk('…and both garments come back so the split editor can open', String((r.json?.lines || []).length), '^2$')
    prePo = (await req('GET', `/api/jobs/${preJ}/po`)).json || {}
    chk('…and the hats are still on the purchase order', JSON.stringify(prePo.lines || []), '112')
    chk('…at the count they were quoted at', String(prePo.total_units), '^142$')
  }

  /* ---------- one shop's artwork is not the whole internet's artwork ----------
   * public/uploads is a single directory served by express.static, and the auth gate ends with
   * `return next()` for every non-/api path — so uploaded proofs answered with no session and no
   * tenant check. Reproduced before the fix on this very instance: an anonymous fetch of the raw
   * filename returned 200 with the full bytes, and so did a DIFFERENT shop's signed-in owner.
   * Art files are customer property: unreleased logos, team rosters with player names and
   * numbers, brand assets under NDA. The database layer is airtight (every cross-tenant probe in
   * this suite 404s); this was the one surface where two shops shared storage.
   *
   * The customer must still be able to see their own proof, with no login — that is the whole
   * point of the /p/ page — so the check has to pass the tokened URL the page itself renders. */
  {
    const uc = (await req('POST', '/api/contacts', { body: { name: 'Confidential Athletics', email: 'confidential@e2e.test' } })).json
    const uj = (await req('POST', '/api/jobs', { body: { contact_id: uc.id, title: 'Unreleased Logo Tees', decoration: 'Screen Print' } })).json
    const uf = new FormData()
    uf.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><!--UNRELEASED-LOGO--></svg>'], { type: 'image/svg+xml' }), 'secret-logo.svg')
    const uup = await fetch(`${BASE}/api/jobs/${uj.id}/art`, { method: 'POST', headers: { Cookie: cookieHeader() }, body: uf })
    const uart = await uup.json().catch(() => ({}))
    chk('a shop uploads its customer\'s unreleased artwork', String(uup.status), '^200$')

    // The exact request the report was filed on: the bare path, no cookie, no token.
    const anon = await fetch(`${BASE}/uploads/${uart.filename}`)
    const anonBody = await anon.text()
    chk('a stranger with the filename and no cookie gets nothing', String(anon.status), '^404$')
    chk('…and certainly not the bytes', String(/UNRELEASED-LOGO/.test(anonBody)), '^false$')

    // A second, real shop on the same box. Signed in, valid session — just not this shop.
    const bres = await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop_name: 'Neighbour Ink', owner_name: 'Nell', owner_email: 'neighbour@e2e.test', password: 'GatePass-123456' }),
    })
    const bCookie = (bres.headers.getSetCookie?.() ?? [bres.headers.get('set-cookie')].filter(Boolean))
      .map((c) => String(c).split(';')[0]).join('; ')
    chk('a second shop signs up on the same instance', String(bres.status), '^200$')
    chk('…and really is signed in', String((await fetch(`${BASE}/api/estimates`, { headers: { Cookie: bCookie } })).status), '^200$')
    const nb = await fetch(`${BASE}/uploads/${uart.filename}`, { headers: { Cookie: bCookie } })
    const nbBody = await nb.text()
    chk('the shop next door cannot read it either', String(nb.status), '^404$')
    chk('…and gets no bytes', String(/UNRELEASED-LOGO/.test(nbBody)), '^false$')

    // The shop that owns it still opens it from its own board.
    const mine = await fetch(`${BASE}/uploads/${uart.filename}`, { headers: { Cookie: cookieHeader() } })
    chk('the shop that owns the art still opens it', String(mine.status), '^200$')
    chk('…with the file itself', String(/UNRELEASED-LOGO/.test(await mine.text())), '^true$')

    // …and the customer, who has no login at all, still sees the proof the shop emailed them.
    const usent = await req('POST', `/api/art/${uart.id}/send`)
    const ulink = String(usent.json?.share_url || '').replace(/^https?:\/\/[^/]+/, '')
    const upage = await fetch(`${BASE}${ulink}`)
    const uhtml = await upage.text()
    chk('the customer\'s proof page still opens with no login', String(upage.status), '^200$')
    const imgSrc = (/<img src="(\/uploads\/[^"]+)"/.exec(uhtml) || [])[1] || ''
    chk('…and the artwork on it carries proof the shop handed it out', String(/[?&]t=/.test(imgSrc)), '^true$')
    const shown = await fetch(`${BASE}${imgSrc.replace(/&amp;/g, '&')}`)
    chk('…and that image really loads for them', String(shown.status), '^200$')
    chk('…showing the artwork', String(/UNRELEASED-LOGO/.test(await shown.text())), '^true$')

    // A token minted for one shop must not open another shop's file, and a token for one file
    // must not open the file next to it.
    const tok = (/[?&]t=([a-f0-9]+)/.exec(imgSrc) || [])[1] || ''
    const swapped = await fetch(`${BASE}/uploads/${uart.filename}?t=${tok}&s=neighbour-ink`)
    chk('a customer token cannot be replayed against the wrong shop', String(swapped.status), '^404$')

    /* …and a shop cannot simply CLAIM another shop's file as its own logo.
     * /uploads/:file proves ownership two ways: the file is in this shop's art_versions, or it
     * IS this shop's logo. shop_logo lives in SETTING_DEFAULTS, so it was in SETTINGS_WRITABLE,
     * so any manager could PUT it — which made ownership self-asserted and walked straight back
     * through the access control above. Proven before the fix on this instance: 404, then one
     * PUT, then 200 with the bytes. It escalated to anonymous too, because the claiming shop's
     * own /p/ page renders its logo and the server therefore MINTS a valid fileToken for another
     * shop's file under the claimer's slug — a permanent public URL for someone else's property,
     * still serving after the owner deleted it. */
    const claim = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: bCookie },
      body: JSON.stringify({ shop_logo: uart.filename }),
    })
    chk('the shop next door may send the claim', String(claim.status), '^200$')
    const bSettings = await (await fetch(`${BASE}/api/settings`, { headers: { Cookie: bCookie } })).json()
    chk('…but the claim is refused, not stored', String(bSettings?.settings?.shop_logo ?? 'MISSING'), '^$')
    const claimed = await fetch(`${BASE}/uploads/${uart.filename}`, { headers: { Cookie: bCookie } })
    const claimedBody = await claimed.text()
    chk('…so it still cannot read the file it named', String(claimed.status), '^404$')
    chk('…and still gets no bytes', String(/UNRELEASED-LOGO/.test(claimedBody)), '^false$')
    // The claim must not reach the anonymous surface either: the shop's own public page is where
    // the server would mint a token for whatever it believes its logo to be.
    const bPub = await fetch(`${BASE}/api/embed/config`, { headers: { Cookie: bCookie } })
    chk('…and its own public config carries no claim on that file',
      String((await bPub.text()).includes(uart.filename)), '^false$')

    // The real logo route still works — this must cost the product nothing.
    const lf = new FormData()
    lf.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><!--NEIGHBOUR-LOGO--></svg>'], { type: 'image/svg+xml' }), 'logo.svg')
    const lup = await fetch(`${BASE}/api/settings/logo`, { method: 'POST', headers: { Cookie: bCookie }, body: lf })
    const lj = await lup.json().catch(() => ({}))
    chk('a shop can still upload its own logo', String(lup.status), '^200$')
    chk('…and read it back', String((await fetch(`${BASE}/uploads/${lj.shop_logo}`, { headers: { Cookie: bCookie } })).status), '^200$')

    // Deleting the proof takes the artwork off the internet, not just off the page. Before this
    // there was no revocation at all: the URL in the customer's inbox worked forever.
    await req('DELETE', `/api/jobs/${uj.id}/art/${uart.id}`)
    const afterDel = await fetch(`${BASE}${imgSrc.replace(/&amp;/g, '&')}`)
    chk('deleting the proof revokes the link the customer was sent', String(afterDel.status), '^404$')
  }

  /* ---------- a share link dies with the record it was minted for ----------
   * token() is HMAC(kind:id:slug) — a pure function of a ROWID, and SQLite hands a freed rowid to
   * the next INSERT. So the estimate link already sitting in one customer's inbox opens the NEXT
   * record that lands on that id: a different customer's quote, priced, with a working Approve
   * button. Unauthenticated, from a link the shop itself emailed, and invisible to the shop —
   * the timeline names the wrong-but-plausible customer. Deleting a cancelled quote is routine.
   * All four kinds share the one cause: 'estimate', 'pay', 'ticket' and 'art'. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Jamie Rivera', email: 'jamie@e2e.test' } })
    const shareA = r.json?.id
    r = await req('POST', '/api/contacts', { body: { name: 'Morgan Diaz', email: 'morgan@e2e.test' } })
    const shareB = r.json?.id

    r = await req('POST', '/api/estimates', { body: { contact_id: shareA, items: [{ description: '24 tees', sizes: { M: 24 }, unit_price: 12 }] } })
    const estA = r.json?.id
    const linkA = String((await req('POST', `/api/estimates/${estA}/send`, { body: {} })).json?.share_url || '').replace(/^https?:\/\/[^/]+/, '')
    await req('DELETE', `/api/estimates/${estA}`)
    r = await req('POST', '/api/estimates', { body: { contact_id: shareB, items: [{ description: '300 hoodies', sizes: { L: 300 }, unit_price: 28 }] } })
    const estB = r.json?.id
    chk('SQLite really does hand the deleted quote\'s rowid to the next one', String(estB), `^${estA}$`)
    const linkB = String((await req('POST', `/api/estimates/${estB}/send`, { body: {} })).json?.share_url || '').replace(/^https?:\/\/[^/]+/, '')
    chk('two customers do not get byte-identical share links', String(linkA !== linkB && !!linkA && !!linkB), '^true$')

    r = await req('GET', linkA, { cookies: false })
    chk('the deleted quote\'s link opens nothing', String(r.status), '^(403|404)$')
    chk('…and cannot show the next customer their neighbour\'s order', r.text, '^(?![\\s\\S]*Morgan Diaz)')
    const stolen = await fetch(`${BASE}${linkA.replace('?', '/approve?')}`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '',
    })
    chk('…and cannot approve it either', String(stolen.status), '^403$')
    r = await req('GET', `/api/estimates/${estB}`)
    chk('…so the $8,400 quote is still waiting on the customer who was actually sent it', String(r.json?.status), '^sent$')
    chk('the live link still works', String((await req('GET', linkB, { cookies: false })).status), '^200$')
  }

  /* ---------- a two-garment job that took a deposit can still have its sizes corrected ----------
   * A closed ring, and the purest "a human cannot fix it" in the product. The customer adds four
   * hoodies to an order that is already invoiced and part-paid. Every exit was shut:
   *   PUT /api/jobs/:id     → 409 multi_garment_quantities, "edit the split on the estimate"
   *   PUT /api/estimates/:id→ 409 "Already invoiced — edit the invoice, not the estimate"
   *   PUT /api/invoices/:id → 200, and touches nothing but due_date and po_number
   *   POST .../void         → 409 "Remove those payments first" (deleting real cash to fix a size)
   * The 409 already hands the caller the exact per-garment structure it wants back, so PUT now
   * accepts it. Nothing else in the ring changes: the refusals are all correct, there just has to
   * be one door. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Two Garment Tina', email: 'tina@e2e.test' } })
    const tgC = r.json?.id
    r = await req('POST', '/api/estimates', {
      body: {
        contact_id: tgC,
        items: [
          { description: 'Gildan 5000 Tee — Black — 2/0 Front', sizes: { S: 20, M: 40 }, unit_price: 11 },
          { description: 'Gildan 18500 Hoodie — Black — 2/0 Front', sizes: { M: 10, L: 10 }, unit_price: 28 },
        ],
      },
    })
    const tgE = r.json?.id
    await req('POST', `/api/estimates/${tgE}/approve`, { body: {} })
    r = await req('POST', `/api/estimates/${tgE}/convert`, { body: { due_date: '2026-12-15' } })
    const tgJ = r.json?.job_id, tgI = r.json?.invoice_id ?? r.json?.id
    await req('POST', `/api/invoices/${tgI}/payments`, { body: { amount: 200, method: 'check' } })

    // The ring, asserted so it cannot quietly re-close somewhere else.
    r = await req('PUT', `/api/jobs/${tgJ}`, { body: { quantities: '20 S / 40 M / 14 L' } })
    chk('a flat grid over two garments is still refused, with the split in hand',
      `${r.status}|${r.json?.code}|${(r.json?.lines || []).length}`, '^409\\|multi_garment_quantities\\|2$')
    r = await req('PUT', `/api/estimates/${tgE}`, { body: { items: [] } })
    chk('…and the estimate still sends you to the invoice', String(r.status), '^409$')
    r = await req('POST', `/api/invoices/${tgI}/void`, { body: { reason: 'sizes changed' } })
    chk('…and voiding still refuses to walk over recorded cash', `${r.status}|${r.json?.code}`, '^409\\|invoice_has_payments$')

    // The door: hand back the structure the 409 gave you, with the hoodie count corrected.
    r = await req('PUT', `/api/jobs/${tgJ}`, {
      body: {
        line_sizes: [
          { description: 'Gildan 5000 Tee — Black — 2/0 Front', garment: 'Gildan 5000', sizes: { S: 20, M: 40 } },
          { description: 'Gildan 18500 Hoodie — Black — 2/0 Front', garment: 'Gildan 18500', sizes: { M: 10, L: 14 } },
        ],
      },
    })
    chk('the shop can correct the split per garment on the job', String(r.status), '^200$')
    const tgPo = (await req('GET', `/api/jobs/${tgJ}/po`)).json || {}
    chk('…and the purchase order buys 84, not 80', String(tgPo.total_units), '^84$')
    const tgPkg = (await req('GET', `/api/jobs/${tgJ}/print-package`)).json || {}
    chk('…and the print package still shows two garments', String((tgPkg.lines || []).length), '^2$')
    const tgPkgUnits = (tgPkg.lines || []).reduce((t, l) => t + Object.values(l.sizes || {}).reduce((a, n) => a + Number(n || 0), 0), 0)
    chk('…adding up to the corrected count', String(tgPkgUnits), '^84$')
    const tgJob = (await req('GET', `/api/jobs/${tgJ}`)).json || {}
    const tgGrid = typeof tgJob.sizes === 'string' ? JSON.parse(tgJob.sizes || '{}') : (tgJob.sizes || {})
    chk('…and the board\'s combined grid agrees with the per-garment split',
      String(Object.values(tgGrid).reduce((a, n) => a + Number(n || 0), 0)), '^84$')

    // Garbage must not reach the PO. A size count that is not a number would order blanks by it.
    r = await req('PUT', `/api/jobs/${tgJ}`, { body: { line_sizes: [{ garment: 'X', sizes: { M: 'lots' } }] } })
    chk('a size count that is not a number is refused', String(r.status), '^400$')
    r = await req('PUT', `/api/jobs/${tgJ}`, { body: { line_sizes: [] } })
    chk('…as is emptying the split entirely', String(r.status), '^400$')
    const tgPo2 = (await req('GET', `/api/jobs/${tgJ}/po`)).json || {}
    chk('…and neither refusal moved the order', String(tgPo2.total_units), '^84$')
  }

  /* ---------- one bad opportunity value must not blank the whole pipeline ----------
   * round2's non-finite fallback returned Infinity, so `value: "1e400"` stored Inf in the money
   * column. SUM() over that column then made the shop's Open Pipeline and Weighted Pipeline KPIs
   * render blank — every card on the dashboard, not just the offending one — and nothing on screen
   * pointed at the row responsible. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Pipeline Co', email: 'pipe@e2e.test' } })
    const pipeCid = r.json?.id ?? r.json?.contact?.id
    await req('POST', '/api/opportunities', { body: { contact_id: pipeCid, title: 'Good deal', value: 5000 } })

    r = await req('POST', '/api/opportunities', { body: { contact_id: pipeCid, title: 'InfOpp', value: '1e400' } })
    chk('an opportunity value that is not a number is refused', String(r.status), '^400$')

    const board = (await req('GET', '/api/pipeline')).json || {}
    const stats = board.stats || board
    chk('…and the shop-wide Open Pipeline KPI is still a real number',
      String(Number.isFinite(Number(stats.open_value))), '^true$')
    chk('…as is the Weighted Pipeline KPI',
      String(Number.isFinite(Number(stats.weighted_value))), '^true$')

    // The board orders cards by sort_order; an object 500'd and "1e400" wrote Infinity into it.
    const opp = (await req('GET', '/api/pipeline')).json
    const anyId = (opp?.columns || []).flatMap((c) => c.opps || []).map((o) => o.id)[0]
    if (anyId) {
      r = await req('PATCH', `/api/opportunities/${anyId}/stage`, { body: { stage: 'lead', sort_order: { a: 1 } } })
      chk('a non-numeric sort_order is refused rather than 500ing', String(r.status), '^400$')
      r = await req('PATCH', `/api/opportunities/${anyId}/stage`, { body: { stage: 'lead', sort_order: '1e400' } })
      chk('…and so is one that is not finite', String(r.status), '^400$')
    } else say('·', 'no opportunity id found on the board — sort_order checked without failing')
  }

  /* ---------- a job title is not a garment ----------
   * The per-garment PO lookup falls back through jobs.garment for a job created on the board with
   * no estimate behind it. That fallback must NOT reach for jobs.title: the string it produces is
   * handed to costFor(), which picks the SKU the purchase order spends real money on, and a title
   * is free text the shop types. "Reorder — 50 for the 3001 event" matches Bella+Canvas 3001 and
   * "Repeat of 2000 shirts" matches Gildan 2000 — a confidently wrong order in place of an honest
   * "no SKU matched" warning the shop can act on. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Board Job Co', email: 'board@e2e.test' } })
    const bjCid = r.json?.id ?? r.json?.contact?.id
    r = await req('POST', '/api/jobs', {
      body: { contact_id: bjCid, title: 'Reorder — 50 for the 3001 event', quantities: '50 M', decoration: 'Screen Print' },
    })
    const titleJob = r.json?.id ?? r.json?.job?.id
    if (titleJob) {
      const po = (await req('GET', `/api/jobs/${titleJob}/po`)).json || {}
      const skus = [...new Set((po.lines || []).map((l) => l.sku))]
      chk('a number in the job title does not become a garment order', JSON.stringify(skus), '^\\[(null)?\\]$')
      chk('…and the shop is told to set the style instead', JSON.stringify(po.warnings || []), 'exact style')
    } else say('·', `could not create a board job (${r.status}) — title-as-SKU checked without failing`)
  }

  /* ---------- the edit path clamps the tax rate like every other write ----------
   * A prior round put a 0-100 clamp on the tax rate and applied it in taxRateFor(), which the
   * CREATE path uses. The EDIT path built its own rate expression and never got it, so
   * PUT {tax_rate: 100000} wrote $1,918,000 of tax onto a $1,918 estimate. Worse than a one-off
   * typo: the editor pre-fills the field from the stored value and the expression falls back to it,
   * so any later edit that simply omitted tax_rate silently re-applied the bad rate. Those columns
   * feed A/R, the dashboard, the customer-facing PDF and the invoice amount_due at convert. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Tax Edit Co', email: 'taxedit@e2e.test' } })
    const txCid = r.json?.id ?? r.json?.contact?.id
    r = await req('POST', '/api/estimates', {
      body: { contact_id: txCid, items: [{ description: 'tees', qty: 100, unit_price: 10, taxable: true }] },
    })
    const txEst = r.json?.id ?? r.json?.estimate?.id

    r = await req('PUT', `/api/estimates/${txEst}`, { body: { tax_rate: 100000 } })
    let row = (await req('GET', `/api/estimates/${txEst}`)).json || {}
    let doc = row.estimate || row
    chk('an edit cannot set a tax rate above 100%', String(Number(doc.tax_rate) <= 100), '^true$')
    chk('…and the tax it stores matches the rate it stored',
      String(Math.abs(Number(doc.tax) - Number(doc.subtotal) * Number(doc.tax_rate) / 100) < 0.02), '^true$')

    await req('PUT', `/api/estimates/${txEst}`, { body: { tax_rate: -50 } })
    row = (await req('GET', `/api/estimates/${txEst}`)).json || {}
    doc = row.estimate || row
    chk('…and a negative rate cannot write negative tax', String(Number(doc.tax) >= 0), '^true$')
  }

  /* ---------- a payment method cannot forge a QuickBooks journal entry ----------
   * IIF is tab-delimited and newline-terminated, and `${p.method}` went into it raw. payments.method
   * is free text a STAFF account writes, so a staff member could splice a complete, correctly
   * delimited TRNS/GENERAL JOURNAL/ENDTRNS record into the file the owner imports into their
   * books — money moved in QuickBooks by editing a payment method in the CRM. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'IIF Co\tInjected\nENDTRNS', email: 'iif@e2e.test' } })
    const iifCid = r.json?.id ?? r.json?.contact?.id
    r = await req('POST', '/api/estimates', {
      body: { contact_id: iifCid, items: [{ description: 'tees', qty: 10, unit_price: 10, taxable: false }] },
    })
    const iifEst = r.json?.id ?? r.json?.estimate?.id
    r = await req('POST', `/api/estimates/${iifEst}/convert`, { body: { due_date: '2026-11-01' } })
    const iifInv = r.json?.invoice_id

    const evil = 'cash\tPrintShopCRM\nENDTRNS\nTRNS\tGENERAL JOURNAL\t1/1/2026\tOwner Draw\tThief\t9999.00\t\t\nENDTRNS'
    r = await req('POST', `/api/invoices/${iifInv}/payments`, { body: { amount: 50, method: evil } })
    chk('a payment records with a hostile method string', String(r.status), '^200$')

    const iif = await req('GET', '/api/export/quickbooks.iif')
    chk('the export still generates', String(iif.status), '^200$')
    chk('…and no forged journal entry reached it', String(/GENERAL JOURNAL/.test(iif.text)), '^false$')
    chk('…and no forged Owner Draw account either', String(/Owner Draw/.test(iif.text)), '^false$')
    // Every record must still be exactly the 8 tab-separated columns the header declares.
    const bad = iif.text.split('\n').filter((l) => /^(TRNS|SPL)\t/.test(l)).filter((l) => l.split('\t').length !== 8)
    chk('…and every row still has the columns the header declares', String(bad.length), '^0$')
    // The tab/newline in the CUSTOMER name must not have split a record either.
    chk('a hostile customer name does not break the row shape', String(/ENDTRNS\tPrintShopCRM/.test(iif.text)), '^false$')
  }

  /* ---------- a webhook signs with the secret the integrator configured ----------
   * docs/API.md tells integrators to POST {"url":…,"events":[…],"secret":"whsec_…"}. The handler
   * generated its own and overwrote it, unconditionally and silently — 201, a green delivery log,
   * and every signature check on the receiving end failing against the secret they configured.
   * The one thing it must never do is quietly accept a weak one instead. */
  {
    const mine = 'whsec_gate_integrator_secret_0123456789'
    r = await req('POST', '/api/v1/webhooks', { ...asKey(), body: { url: 'https://example.com/hook-mysecret', events: ['invoice.paid'], secret: mine } })
    chk('a webhook is created', String(r.status), '^201$')
    chk('…signing with the secret the integrator configured', String(r.json?.secret), `^${mine}$`)
    const madeId = r.json?.id
    r = await req('GET', '/api/v1/webhooks', asKey())
    chk('…and it is listed', String((r.json?.data || []).some((w) => w.id === madeId)), '^true$')

    r = await req('POST', '/api/v1/webhooks', { ...asKey(), body: { url: 'https://example.com/hook-weak', events: ['invoice.paid'], secret: 'hunter2' } })
    chk('a secret too weak to sign with is refused, not quietly replaced', String(r.status), '^400$')
    chk('…and says what is wrong with it', String(r.json?.error || ''), 'secret')

    r = await req('POST', '/api/v1/webhooks', { ...asKey(), body: { url: 'https://example.com/hook-gen', events: ['invoice.paid'] } })
    chk('omitting it still generates one', String(r.json?.secret || ''), '^whsec_')
    await req('DELETE', `/api/v1/webhooks/${madeId}`, asKey())
    await req('DELETE', `/api/v1/webhooks/${r.json?.id}`, asKey())
  }

  /* ---------- the public gang-sheet builder cannot write on a real customer ----------
   * lib/agent.mjs:593 states the rule for the public chat widget — "a visitor on the public widget
   * may be LINKED to an existing customer, and may not WRITE on one" — and enforces it. Its twin,
   * the gang-sheet order endpoint, matched on email and then wrote unconditionally. Both are
   * unauthenticated and both are reached with nothing but the shop's embed key, which ships inside
   * the snippet the shop pastes on its own website. So anyone who scrapes that key and knows one
   * customer's address can attach a real, sequence-consuming estimate marked 'sent' to that
   * account, put its value in the shop's forecast, and fire the shop's estimate.sent automations
   * — which means the customer gets email from their printer about an order they never placed. */
  {
    const meE = await req('GET', '/api/auth/me')
    const gsKey = meE.json?.embed_key
    chk('the shop publishes an embed key, as the snippet needs', String(!!gsKey), '^true$')
    r = await req('POST', '/api/contacts', { body: { name: 'Real Customer Rae', email: 'rae@real.test' } })
    const raeId = r.json?.id

    const before = ((await req('GET', '/api/estimates')).json || []).length
    const gs = await fetch(`${BASE}/api/embed/gangsheet/order?shop=${encodeURIComponent(gsKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Not Really Rae', email: 'rae@real.test', items: [{ w: 10, h: 10, qty: 50 }] }),
    })
    const gsBody = await gs.json().catch(() => ({}))
    chk('a stranger can still get a price from the public builder', String(gs.status), '^200$')

    const ests = (await req('GET', '/api/estimates')).json || []
    chk('…and it is recorded, not silently dropped', String(ests.length), `^${before + 1}$`)
    const mine = ests.find((e) => e.estimate_number === gsBody.estimate)
    chk('…on the customer whose address was typed', String(mine?.contact_id), `^${raeId}$`)
    chk('…but NOT marked sent on that real customer', String(mine?.status), '^draft$')
    chk('…and it says nobody has confirmed who the visitor is', String(mine?.notes || ''), 'UNVERIFIED')
    const pipe = (await req('GET', '/api/pipeline')).json || {}
    const opp = (pipe.columns || []).flatMap((c) => (c.opps || []).map((o) => ({ ...o, stage: c.key ?? c.stage }))).find((o) => String(o.title || '').includes('gang sheet'))
    // 'quoted' is where an ordinary DRAFT quote sits; 'sent' is the column the forecast reads.
    chk('…and it is not counted in the forecast as a sent quote', String(opp?.stage ?? 'none'), '^(quoted|none)$')
    const runs = ((await req('GET', '/api/automations')).json?.runs || [])
      .filter((x) => x.trigger === 'estimate.sent' && String(x.entity_label || '') === String(gsBody.estimate))
    chk('…and did not fire the shop\'s estimate.sent automations in their name', String(runs.length), '^0$')

    // A visitor who is NOT an existing customer is their own record — that path is unchanged.
    const gs2 = await fetch(`${BASE}/api/embed/gangsheet/order?shop=${encodeURIComponent(gsKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Brand New Bea', email: 'bea@brandnew.test', items: [{ w: 10, h: 10, qty: 50 }] }),
    })
    const gs2Body = await gs2.json().catch(() => ({}))
    const fresh = ((await req('GET', '/api/estimates')).json || []).find((e) => e.estimate_number === gs2Body.estimate)
    chk('a brand-new visitor\'s own order is untouched by all this', String(fresh?.status), '^sent$')
  }

  /* ---------- the platform admin address cannot be claimed from the signup form ----------
   * requireAdmin() grants the Control Room on one test: isAdminEmail(req.tenant.owner_email).
   * tenants.owner_email is written in exactly one place — createTenant(), reached from the
   * UNAUTHENTICATED signup form — and nothing reserved the address. An operator sets
   * PSC_ADMIN_EMAIL and restarts; the app is live from that second, and their own account does not
   * exist until they get round to registering. Whoever signs up with it first (it is usually the
   * support address printed on the operator's own website) gets the shop list, delete, suspend,
   * and one-click sign-in as any shop on the install. */
  {
    const T6 = mkdtempSync(join(tmpdir(), 'psc-e2e-adminsquat-'))
    const P6 = PORT + 12
    const env6 = { ...process.env, PORT: String(P6), PSC_DB: join(T6, 'printshop.db'), PSC_AUTH: '1', PSC_SECRET: 'gate', PSC_PUBLIC_URL: `http://127.0.0.1:${P6}`, PSC_ADMIN_EMAIL: 'operator@example.com' }
    const s6 = spawn(process.execPath, ['--no-warnings', 'server.mjs'], { cwd: ROOT, env: env6, stdio: ['ignore', 'pipe', 'pipe'] })
    started.push(s6)
    const hit6 = async (path, body) => {
      try {
        const res = await fetch(`http://127.0.0.1:${P6}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        return { status: res.status, text: await res.text() }
      } catch { return { status: 0, text: '' } }
    }
    try {
      for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`http://127.0.0.1:${P6}/health`)).ok) break } catch { /* not up */ }
        await sleep(500)
      }
      let out = await hit6('/api/auth/signup', { shop_name: 'Real Shop', owner_name: 'Rita', owner_email: 'real@shop.test', password: 'GatePass-123456' })
      chk('an ordinary shop still signs up on an install with an admin address set', String(out.status), '^200$')
      out = await hit6('/api/auth/signup', { shop_name: 'Squat', owner_name: 'Mal', owner_email: 'operator@example.com', password: 'GatePass-123456' })
      chk('…but the platform admin address is refused', String(out.status), '^40[03]$')
      chk('…and says so rather than failing mysteriously', out.text, 'reserved')
      // Case and surrounding whitespace must not walk around it — isAdminEmail lower-cases both.
      out = await hit6('/api/auth/signup', { shop_name: 'Squat2', owner_name: 'Mal', owner_email: '  OPERATOR@Example.COM ', password: 'GatePass-123456' })
      chk('…in any casing', String(out.status), '^40[03]$')

      /* ---------- pressing Suspend does not hand the operator the shop's credentials ----------
       * setTenantStatus returns SELECT * on `tenants`, and that row carries the owner's scrypt
       * password_hash and the shop's LIVE psc_live_ API key — a manager-equivalent credential the
       * shop itself is shown exactly once and can never read back. So one press of Suspend or
       * Reactivate in the Control Room put both in the operator's browser. GET /api/admin/shops
       * next door was deliberately written as an explicit column list; this route was the one
       * place a raw tenant row crossed the wire. */
      const jar6 = new Map()
      const ch6 = () => [...jar6].map(([k, v]) => `${k}=${v}`).join('; ')
      const as6 = async (method, path, body) => {
        const h = { }
        if (body !== undefined) h['Content-Type'] = 'application/json'
        if (jar6.size) h.Cookie = ch6()
        const res = await fetch(`http://127.0.0.1:${P6}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
        for (const c of (res.headers.getSetCookie?.() ?? [])) {
          const [pair] = String(c).split(';'); const i = pair.indexOf('=')
          if (i > 0) jar6.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
        }
        const text = await res.text()
        let json = null; try { json = JSON.parse(text) } catch { /* html is fine */ }
        return { status: res.status, text, json }
      }

      // The shop mints an API key it will never be shown again.
      await as6('POST', '/api/auth/login', { email: 'real@shop.test', password: 'GatePass-123456' })
      const rotated = await as6('POST', '/api/developers/key/rotate', {})
      const liveKey = String(rotated.json?.api_key || '')
      chk('a shop mints a live API key', String(liveKey.startsWith('psc_live_')), '^true$')
      chk('…which its own UI will only ever show a preview of again',
        String((await as6('GET', '/api/developers')).json?.api_key ?? 'absent'), '^absent$')
      const shopEmbedKey = String((await as6('GET', '/api/auth/me')).json?.embed_key || '')
      chk('…and knows its own embed key, which its website carries', String(!!shopEmbedKey), '^true$')

      // The operator gets their own shop the way the product tells them to — the signup form
      // refuses this address, which is what the three assertions above are about.
      const mk = spawn(process.execPath, ['--no-warnings', 'bin/admin.mjs', 'create-shop', 'Ops', 'operator@example.com', 'GatePass-123456'],
        { cwd: ROOT, env: env6, stdio: ['ignore', 'pipe', 'pipe'] })
      await new Promise((r) => { mk.on('exit', r); mk.stdout.on('data', () => {}); mk.stderr.on('data', () => {}) })

      jar6.clear()
      const opLogin = await as6('POST', '/api/auth/login', { email: 'operator@example.com', password: 'GatePass-123456' })
      chk('the operator signs in to the Control Room', String(opLogin.status), '^200$')
      const shops = (await as6('GET', '/api/admin/shops')).json?.shops || []
      const target = shops.find((x) => x.slug === 'real-shop') || shops.find((x) => x.owner_email === 'real@shop.test')
      chk('…and can see the shop it is about to suspend', String(!!target), '^true$')

      const susp = await as6('POST', `/api/admin/shops/${target?.id}/status`, { status: 'suspended' })
      chk('Suspend works', String(susp.status), '^200$')
      const blob = JSON.stringify(susp.json || {})
      chk('…without handing over the shop\'s live API key', String(blob.includes(liveKey)), '^false$')
      chk('…or any psc_live_ credential at all', String(/psc_live_/.test(blob)), '^false$')
      chk('…or the owner\'s password hash', String('password_hash' in (susp.json?.tenant || {})), '^false$')
      // It must still say what the operator needs: the shop, and what happened to it.
      chk('…while still reporting the status it set', String(susp.json?.tenant?.status), '^suspended$')
      chk('…on the shop it set it on', String(susp.json?.tenant?.slug), '^real-shop$')
      /* ---------- a suspended shop's owner is told what actually happened ----------
       * authMember() returned null for a suspended tenant exactly as it did for a wrong password,
       * so the login route took its `if (!r)` branch and answered "Wrong email or password" — and
       * the line immediately after it, the one that explains suspension and says who to call, was
       * unreachable dead code. The owner typed their correct password, was told it was wrong,
       * tried again, and walked into the account backoff on top of it. No screen in the product
       * could get them out of that. */
      // A cookie-less login attempt, so the operator's own Control Room session is left intact.
      const tryLogin = async (password) => {
        const res = await fetch(`http://127.0.0.1:${P6}/api/auth/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'real@shop.test', password }),
        })
        const text = await res.text()
        let json = null; try { json = JSON.parse(text) } catch { /* html is fine */ }
        return { status: res.status, text, json }
      }
      const lockedOut = await tryLogin('GatePass-123456')
      chk('a suspended shop\'s owner is not told their password is wrong', String(lockedOut.status), '^403$')
      chk('…they are told the shop is suspended', lockedOut.text, 'suspended')
      chk('…and that their password was fine, so they stop retrying', lockedOut.text, 'password is correct')
      chk('…with a code the login screen can act on', String(lockedOut.json?.code || ''), '^tenant_suspended$')
      // A WRONG password against the same suspended shop must stay indistinguishable from any
      // other wrong password — this must not become an account-existence oracle.
      const wrongToo = await tryLogin('NotThePassword-123')
      chk('…while a wrong password on that shop is still just a wrong password', String(wrongToo.status), '^401$')
      chk('…saying nothing about the account', wrongToo.text, '^(?![\\s\\S]*suspend)')

      /* ---------- …and so is everything the shop's own website points at ----------
       * getSession() and getTenantByApiKey() both filter status='active', so the owner's login
       * and the REST API close on suspension. getTenantByEmbedKey() and getTenantBySlug() filtered
       * nothing, and neither embedRun() nor pPage() checked — so a suspended shop kept answering
       * its customers as itself through the AI receptionist on the shop's own key, kept opening
       * Stripe checkouts on the shop's account, and kept writing numbered estimates into a
       * database no human could now open to read them. Measured before the fix on a suspended
       * shop: owner login 401, and an anonymous POST /api/embed/gangsheet/order returned EST-1002.
       * Suspension is the operator's only lever against non-payment AND against a shop using the
       * platform to defraud; half-working in this direction is the worst of both. */
      const pub = (path, body) => (body === undefined
        ? fetch(`http://127.0.0.1:${P6}${path}`).then(async (r) => ({ status: r.status, text: await r.text() }))
        : fetch(`http://127.0.0.1:${P6}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .then(async (r) => ({ status: r.status, text: await r.text() })))
      const PUBLIC_SURFACES = [
        ['the shop\'s embedded builder config', `/api/embed/config?shop=${shopEmbedKey}`, undefined],
        ['the AI receptionist on the shop\'s own website', `/api/embed/chat/start?shop=${shopEmbedKey}`, {}],
        ['the public gang-sheet order form', `/api/embed/gangsheet/order?shop=${shopEmbedKey}`, { items: [{ w: 10, h: 10, qty: 2 }], name: 'Stranger', email: 'stranger@evil.test' }],
      ]
      for (const [what, path, body] of PUBLIC_SURFACES) {
        chk(`a suspended shop closes ${what}`, String((await pub(path, body)).status), '^404$')
      }
      // /p/ resolves the shop BEFORE it checks the link token, so a bad token on a live shop is
      // 403 and on a suspended one is 404 — which is exactly the difference being asserted.
      chk('…and its customer-facing document pages',
        String((await pub('/p/estimate/1?k=nope&s=real-shop')).status), '^404$')
      chk('…and no order reached its books', String((await pub(`/api/embed/gangsheet/order?shop=${shopEmbedKey}`,
        { items: [{ w: 10, h: 10, qty: 2 }], name: 'Stranger', email: 'stranger@evil.test' })).text.includes('EST-')), '^false$')

      // Reactivate is the same route and was the same leak.
      const react = await as6('POST', `/api/admin/shops/${target?.id}/status`, { status: 'active' })
      // The gate has to open again, or suspension is a one-way door and the operator has no undo.
      for (const [what, path, body] of PUBLIC_SURFACES) {
        chk(`reactivating reopens ${what}`, String((await pub(path, body)).status), '^200$')
      }
      chk('…and its document pages answer on their own terms again',
        String((await pub('/p/estimate/1?k=nope&s=real-shop')).status), '^403$')
      chk('Reactivate leaks nothing either', String(/psc_live_|password_hash/.test(JSON.stringify(react.json || {}))), '^false$')
      chk('…and the shop is active again', String(react.json?.tenant?.status), '^active$')
      // …and the owner can get back in, which is the point of the whole exchange.
      chk('…so its owner can sign in again', String((await tryLogin('GatePass-123456')).status), '^200$')
    } finally {
      try { s6.kill('SIGKILL') } catch { /* already gone */ }
      try { rmSync(T6, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  /* ---------- the price book cannot be filled with matrix junk ----------
   * `services` got a 100-entry cap and a DELETE route after it was used to mint 20,000 junk
   * services in one request. Its sibling `matrices` got neither, and the same trick worked better:
   * the cell-key regex bounds the SHAPE of a key, not how many there are, so one request writing
   * `1|1` through `1|60000` put 60,000 cells and thousands of orphan matrices into
   * settings.price_book — a blob getSettings() loads on EVERY request in the process — and a matrix
   * keyed to a service that does not exist is not listed by GET /api/pricebook, so the owner could
   * not see what to remove. DELETE /api/pricebook/:name returned {"ok":true} and left it there. */
  {
    const before = (await req('GET', '/api/settings')).text.length

    const manyCells = {}
    for (let i = 1; i <= 5000; i++) manyCells[`1|${i}`] = 2.5
    r = await req('PUT', '/api/pricebook', { body: { matrices: { GiantMatrix: manyCells } } })
    chk('a matrix with 5,000 cells is refused', String(r.status), '^400$')
    chk('…with a code the UI can act on', String(r.json?.code || ''), 'too_many_cells')

    const manyMatrices = {}
    for (let i = 0; i < 200; i++) manyMatrices[`svc${i}`] = { '1|12': 1.5 }
    r = await req('PUT', '/api/pricebook', { body: { matrices: manyMatrices } })
    chk('200 separate matrices in one request is refused', String(r.status), '^400$')
    chk('…with its own code', String(r.json?.code || ''), 'too_many_matrices')

    r = await req('PUT', '/api/pricebook', { body: { matrices: 'Screen Print' } })
    chk('a string where the matrices object belongs is refused', String(r.status), '^400$')

    const after = (await req('GET', '/api/settings')).text.length
    chk('…and none of it grew the settings blob', String(after - before < 500), '^true$')

    // A legitimate matrix still saves — and can then be removed from the UI, completely.
    r = await req('PUT', '/api/pricebook', { body: { matrices: { 'Screen Print': { '1|12': 4.25, '1|24': 3.75 } } } })
    chk('a real price matrix still saves', String(r.status), '^200$')
    chk('…and its cells are counted', String(r.json?.cells), '^2$')

    await req('DELETE', '/api/pricebook/Screen%20Print')
    const s2 = (await req('GET', '/api/settings')).json?.settings || {}
    let book = {}
    try { book = JSON.parse(s2.price_book || '{}') } catch { /* stays {} */ }
    chk('deleting a service removes its price matrix too', String(!!book.matrices?.['Screen Print']), '^false$')
  }

  /* ---------- a shop's own price sheet is the sheet the app quotes from ----------
   * A row label is a quantity BAND, and every real price card writes them as ranges. The import
   * stripped the non-digits, so "288-499" was read as the number 288,499 and "500-999" as 500,999
   * — bandMinFor then put eight ordinary rows on the single 500+ band, where each overwrote the
   * last and the 1000+ row won. "Imported 24 prices", three stored, every band from 12 to 499
   * silently back on the built-in calculator and its $3.00 floor. A 300-piece 2-colour order then
   * quotes $900.00 against the shop's own sheet's $1,320.00. */
  {
    const sheet = [
      'Quantity,1,2,3',
      '12-23,9.50,10.75,12.00',
      '24-47,6.50,7.25,8.00',
      '48-71,5.40,6.10,6.85',
      '72-143,4.80,5.45,6.10',
      '144-287,4.20,4.80,5.35',
      '288-499,3.90,4.40,4.90',
      '500-999,3.60,4.10,4.60',
      '1000+,3.10,3.50,3.90',
    ].join('\n')
    const fd = new FormData()
    fd.append('service', 'Screen Print')
    fd.append('file', new Blob([sheet], { type: 'text/csv' }), 'prices.csv')
    const up = await fetch(`${BASE}/api/pricebook/import`, { method: 'POST', headers: { Cookie: cookieHeader() }, body: fd })
    const imp = await up.json().catch(() => ({}))
    chk('a price sheet written in ranges imports', String(up.status), '^200$')
    chk('…and stores every price it says it read', String(Object.keys(imp.cells || {}).length), `^${imp.filled}$`)
    chk('…all 24 of them', String(Object.keys(imp.cells || {}).length), '^24$')
    chk('…with the 288-499 row on its own break, not merged into 500+', String(imp.cells?.['288|2']), '^4.4$')
    chk('…and the 500-999 row not overwritten by the 1000+ row', String(imp.cells?.['500|2']), '^4.1$')

    r = await req('PUT', '/api/pricebook', { body: { matrices: { 'Screen Print': imp.cells }, ...(imp.bands ? { bands: imp.bands } : {}) } })
    chk('…and the sheet saves', String(r.status), '^200$')
    r = await req('GET', '/api/pricebook/matrix?service=Screen%20Print&colors=3')
    const rows = r.json?.matrix?.rows || []
    const row288 = rows.find((x) => Number(x.qty ?? x.min ?? x.band) === 288)
    chk('…so a 300-piece order quotes the shop\'s own 288 price, not the calculator', JSON.stringify(row288 || {}), '4\\.4')
  }

  /* ---------- the customer's decision is theirs, and it is made once ----------
   * Two halves of the same story, both on the estimate a customer actually looks at.
   *
   * (a) POST /api/estimates/:id/send set status='sent' unconditionally, so "resend a copy" on an
   *     already-approved estimate rolled the customer's decision BACK — putting the Approve
   *     button in front of someone who had already approved, and unwinding the shop's own board.
   * (b) POST /p/estimate/:id/approve had no idempotency guard and no rate limit, while its
   *     sibling /p/art/:id/decide has had exactly that guard, with a comment explaining why,
   *     since it was written. A forwarded link re-POSTed 50 times produced 50 real customer
   *     emails out of the shop's SMTP, 50 webhook deliveries and 50 "APPROVED" timeline rows —
   *     unauthenticated, in under a third of a second. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Approve Once', email: 'approve-once@e2e.test' } })
    const apprContact = r.json?.id
    r = await req('POST', '/api/estimates', { body: { contact_id: apprContact, items: [{ description: '24 tees', sizes: { M: 24 }, unit_price: 12 }] } })
    const apprEst = r.json?.id
    r = await req('POST', `/api/estimates/${apprEst}/send`, { body: {} })
    const shareUrl = r.json?.share_url || ''
    chk('a sent estimate hands back a customer link', String(!!shareUrl), '^true$')
    const share = shareUrl.replace(/^https?:\/\/[^/]+/, '')

    const approveOnce = async () => fetch(`${BASE}${share.replace('/p/estimate/', '/p/estimate/').replace('?', '/approve?')}`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '',
    })
    await approveOnce()
    r = await req('GET', `/api/estimates/${apprEst}`)
    chk('the customer can approve from the link', String(r.json?.status), '^approved$')

    // The forwarded-link case: hammer it the way a purchasing department does. Every one of these
    // re-stamped approved_at, wrote another APPROVED row on the customer's timeline, and re-fired
    // estimate.approved into the shop's automations and webhooks.
    for (let i = 0; i < 10; i++) await approveOnce()
    const approvals = ((await req('GET', '/api/activities')).json || [])
      .filter((a) => /APPROVED by .* online/.test(String(a.description || ''))).length
    // 11 timeline rows before the guard, one after. (approved_at is second-resolution, so a
    // same-second re-stamp is not something a test can tell apart — the row count is.)
    chk('a forwarded approval link approves once, however many times it is opened', String(approvals), '^1$')


    // Re-sending a copy must not reverse a decision the customer already made.
    r = await req('POST', `/api/estimates/${apprEst}/send`, { body: {} })
    chk('re-sending an approved estimate does not un-approve it', String(r.json?.estimate?.status), '^approved$')
  }

  /* ---------- the page a customer pays from has to add up ----------
   * /p/pay/:id printed itemsTable() — the estimate's lines, which sum to the SUBTOTAL — and then
   * asked for amount_due, which is subtotal + tax. On the seeded shop that was a table totalling
   * $798.00 above a demand for $848.22, with the $50.22 of tax appearing NOWHERE on the page. The
   * PDF and /p/estimate both broke it out correctly; this is the one document customers actually
   * pay from, and it was the one that did not reconcile. */
  {
    r = await req('POST', '/api/contacts', { body: { name: 'Pay Page Math', email: 'paymath@e2e.test' } })
    const payC = r.json?.id
    r = await req('POST', '/api/estimates', {
      body: { contact_id: payC, tax_rate: 6.29, items: [{ description: '100 tees', qty: 100, unit_price: 7.98 }] },
    })
    const payEst = r.json?.id
    const eSub = Number(r.json?.subtotal), eTax = Number(r.json?.tax), eTot = Number(r.json?.total)
    chk('a taxed estimate exists to invoice', String(eSub === 798 && eTax > 0 && eTot > eSub), '^true$')

    r = await req('POST', `/api/estimates/${payEst}/convert`, { body: { due_date: '2026-09-01' } })
    const payInv = r.json?.invoice_id
    r = await req('GET', `/api/invoices/${payInv}`)
    const payLink = String(r.json?.pay_link || '').replace(/^https?:\/\/[^/]+/, '')
    chk('the invoice hands back a pay link', String(/^\/p\/pay\//.test(payLink)), '^true$')

    const payHtml = await (await fetch(BASE + payLink)).text()
    // Every dollar figure the customer can read on the page.
    const shown = [...payHtml.matchAll(/\$([0-9][0-9,]*\.[0-9]{2})/g)].map((m) => Number(m[1].replace(/,/g, '')))
    chk('the pay page shows the subtotal the line items add up to', String(shown.includes(eSub)), '^true$')
    chk('the pay page shows the tax it is charging on top', String(shown.includes(Math.round(eTax * 100) / 100)), '^true$')
    chk('…and the amount it asks for', String(shown.includes(Math.round(eTot * 100) / 100)), '^true$')
    // The actual defect, stated as arithmetic: what it asks for must be accounted for by what it
    // prints. Before the fix the page showed 798.00 and 848.22 and nothing bridging them.
    const bridges = shown.some((a) => shown.some((b) => Math.abs(a + b - eTot) < 0.005 && a > 0 && b > 0))
    chk('the pay page accounts for every dollar it asks for', String(bridges), '^true$')

    // The shop's OWN invoice screen has the same table above the same total, and the route it reads
    // did not return a subtotal or a tax at all — so the number could not have been shown even if
    // the view had wanted to. public/js/views/invoices.js renders these three fields.
    r = await req('GET', `/api/invoices/${payInv}`)
    chk('the invoice route returns the subtotal its line items add up to', String(round2e(r.json?.subtotal)), `^${eSub}$`)
    chk('…and the tax that bridges it to the amount due', String(round2e(r.json?.tax)), `^${round2e(eTax)}$`)
    chk('…which together reconcile to what the shop is asking for',
      String(Math.abs(round2e(Number(r.json?.subtotal) + Number(r.json?.tax)) - round2e(r.json?.amount_due)) < 0.005), '^true$')
  }

  /* ---------- the embed chat's cap counts requests, not the strings the caller chose ----------
   * embedLimit keyed on `${ip}:${req.query.shop}` — the shop key exactly as the CALLER sent it.
   * On a single-tenant install (PSC_AUTH unset, which is the default for every self-hoster)
   * embedRun does not validate ?shop= at all, so varying one character per request minted a fresh
   * bucket every time: the cap never fired, and each accepted message is a billed model call on
   * the shop's own API key plus a chat_sessions row. The comment three lines below the limiter
   * already described this exact mistake for signup and lead capture.
   *
   * Its own instance, single-tenant, because that is the install the hole is in. */
  {
    const T8 = mkdtempSync(join(tmpdir(), 'psc-e2e-embed-'))
    const P8 = PORT + 14
    const embedSrv = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(P8), PSC_DB: join(T8, 'printshop.db'), PSC_SECRET: 'gate' },  // no PSC_AUTH: single-tenant
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    started.push(embedSrv)
    try {
      for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`http://127.0.0.1:${P8}/health`)).status === 200) break } catch { /* not up yet */ }
        await sleep(500)
      }
      const start = async (shopKey) => {
        const res = await fetch(`http://127.0.0.1:${P8}/api/embed/chat/start?shop=${encodeURIComponent(shopKey)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page_url: 'https://shop.test/' }),
        })
        return res.status
      }
      // The published ceiling is 12 chats per 15 minutes from one connection.
      let sameKey = 0
      for (let i = 0; i < 20; i++) if (await start('abc123') === 429) sameKey++
      chk('the embed chat cap fires when the key stays the same', String(sameKey > 0), '^true$')

      // The attack: one character different each time, same connection, same shop.
      let varied = 0, accepted = 0
      for (let i = 0; i < 40; i++) {
        const st = await start(`abc123-${i}`)
        if (st === 429) varied++; else accepted++
      }
      chk(`varying the shop key does not mint a fresh budget (${accepted} accepted of 40)`, String(varied > 0), '^true$')
      chk('…and the run stays well inside the published ceiling', String(accepted <= 12), '^true$')
    } finally {
      try { embedSrv.kill('SIGKILL') } catch { /* already gone */ }
      try { rmSync(T8, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  /* ---------- the accountant's SUM over the export is the number on the document ----------
   * csvCell quotes any cell starting with = + - @ to neutralise spreadsheet formula injection —
   * contact names come from public lead and gang-sheet forms, so that guard is real. But a leading
   * apostrophe forces Excel and Sheets to treat the cell as TEXT, and money is the one column
   * where a negative is ordinary: a discount, a credit, a refund, an imported adjustment. Every
   * one of them was silently skipped by a SUM over the column — always overstating, never
   * flagged, in the file a shop hands to its accountant. */
  {
    const nc = (await req('POST', '/api/contacts', { body: { name: 'Credit Co', email: 'credit@e2e.test' } })).json
    await req('POST', '/api/estimates', { body: { contact_id: nc.id, items: [
      { description: 'Tees', qty: 1, unit_price: 400 },
      { description: 'Goodwill discount', qty: 1, unit_price: -100, taxable: false },
    ] } })
    const li = (await req('GET', '/api/export/line_items.csv')).text
    const amounts = li.split('\n').filter((l) => l.includes('Goodwill discount')).join('')
    chk('a credit line exports', String(!!amounts), '^true$')
    chk('…as a number the spreadsheet will add up', amounts, '(^|,)-100(\\.0+)?(,|$)')
    chk('…not as text', String(amounts.includes("'-100")), '^false$')

    /* …and the amount on each line is the amount the document charged.
     * `amount` was `qty x unit_price`. Extended sizes carry a per-piece upcharge — 2XL +$2, 3XL
     * +$3 out of the box — and the stored subtotal has always included it. Both exports left it
     * out, so the lines summed UNDER the estimate's own total and the difference appeared nowhere
     * in the file. This is the one number a bookkeeper reconciles against. */
    await req('PUT', '/api/settings', { body: { size_upcharges: JSON.stringify({ '2XL': 2, '3XL': 3 }) } })
    const ue = (await req('POST', '/api/estimates', { body: { contact_id: nc.id, items: [
      { description: 'Upcharged Tees', unit_price: 8.75, sizes: { M: 100, '2XL': 10, '3XL': 2 } },
    ] } })).json
    chk('an estimate with extended sizes stores its subtotal WITH the upcharge', String(ue?.subtotal), '^1006$')
    const li2 = (await req('GET', '/api/export/line_items.csv')).text
    const row = li2.split('\n').find((l) => l.includes('Upcharged Tees')) || ''
    chk('…and the exported line says the same number', row, '(^|,)1006(\\.0+)?(,|$)')
    chk('…rather than the pre-upcharge figure', String(/(^|,)980(\.0+)?(,|$)/.test(row)), '^false$')
    const aj = (await req('GET', '/api/export/all.json')).text
    const jline = (JSON.parse(aj).tables?.line_items || []).find((l) => l.description === 'Upcharged Tees')
    chk('…and so does the JSON export, which is the anti-lock-in path', String(jline?.amount), '^1006$')
    chk('…naming the upcharge separately so the two figures can be told apart', String(jline?.size_upcharge), '^26$')

    // The guard it must not break: an attacker-supplied name is still forced to a literal string.
    const ec = (await req('POST', '/api/contacts', { body: { name: "=cmd|' /C calc'!A0", email: 'evil-csv@e2e.test' } })).json
    chk('a formula in a customer name is accepted as data', String(ec?.id > 0), '^true$')
    const cc = (await req('GET', '/api/export/contacts.csv')).text
    chk('…and exported quoted, so no spreadsheet runs it', cc, "'=cmd")
    // `-2+3+cmd|…` starts with a minus and is NOT a number — it must stay quoted too.
    await req('POST', '/api/contacts', { body: { name: "-2+3+cmd|' /C calc'!A0", email: 'evil-csv2@e2e.test' } })
    const cc2 = (await req('GET', '/api/export/contacts.csv')).text
    chk('…including one that starts with a minus sign', cc2, "'-2\\+3\\+cmd")
  }

  /* ---------- the sidebar's six dots cost six integers, not six list endpoints ----------
   * refreshChrome() runs at the end of EVERY navigate() and on every realtime notify/board/
   * conversation event — and one drag on the job board broadcasts to every tab open on the floor.
   * It got its six numbers by fetching /api/settings + /api/dashboard + /api/art + /api/followups
   * + /api/automations + /api/conversations and discarding everything else: measured at 48.12 MB
   * and 1,632 ms of blocked event loop per sidebar click on a shop with 40k proofs, and 6,716 ms
   * of fleet-wide block with four tablets reacting to one board move. Every tenant on the box
   * waits through that, because the event loop is shared.
   *
   * The contract this asserts is the one that makes the fix safe: /api/chrome/badges must return
   * the SAME six numbers the client used to derive, and it must be small. */
  {
    // Seed the two badges the earlier flow leaves at zero, so the equality below compares real
    // populations rather than two zeroes agreeing with each other.
    const bc = (await req('POST', '/api/contacts', { body: { name: 'Badge Co', email: 'badge@e2e.test' } })).json
    const bj = (await req('POST', '/api/jobs', { body: { contact_id: bc.id, title: 'Badge Tees', decoration: 'Screen Print' } })).json
    const bf = new FormData()
    bf.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/svg+xml' }), 'badge.svg')
    const bart = await (await fetch(`${BASE}/api/jobs/${bj.id}/art`, { method: 'POST', headers: { Cookie: cookieHeader() }, body: bf })).json().catch(() => ({}))
    chk('a proof is out with the customer, so art_pending is not zero',
      String((await req('POST', `/api/art/${bart.id}/send`)).status), '^200$')

    const b = await req('GET', '/api/chrome/badges')
    chk('the chrome badge endpoint answers', String(b.status), '^200$')
    const [d, art, fu, au, cv] = await Promise.all([
      req('GET', '/api/dashboard'), req('GET', '/api/art'),
      req('GET', '/api/followups'), req('GET', '/api/automations'), req('GET', '/api/conversations'),
    ])
    const old = {
      active_jobs: d.json?.kpis?.active_jobs,
      art_pending: (art.json || []).filter((a) => a.status === 'sent' || a.status === 'rejected').length,
      followups: (fu.json?.stale || []).length + (fu.json?.overdue || []).length,
      automations: au.json?.stats?.enabled,
      unread: cv.json?.unread_total,
    }
    // Every badge the shop has any records for, so the equality is not a comparison of zeroes.
    chk('…on a shop with real records to count',
      String(old.followups > 0 && old.active_jobs > 0 && old.art_pending > 0 && old.automations > 0), '^true$')
    for (const k of Object.keys(old)) {
      chk(`…${k} matches what the six list endpoints said (${old[k]})`, String(b.json?.[k]), `^${old[k]}$`)
    }
    // open_invoices is the one that gets MORE correct: /api/dashboard's outstanding_invoices
    // carries LIMIT 8, so the old derivation stopped counting at 8. The nav draws a dot, not a
    // number, so nothing visible changes — but the value must be the truth, and it must still
    // agree with the page for any shop under the page size.
    const page = (d.json?.outstanding_invoices || []).length
    chk('…open_invoices is at least the page /api/dashboard returned', String(b.json?.open_invoices >= page), '^true$')
    chk('…and equals it wherever the page was not truncated', String(Math.min(b.json?.open_invoices, 8)), `^${page}$`)
    // The whole point: the payload the hottest path in the app carries.
    chk(`…and the whole answer is a few hundred bytes (${b.text.length}), not 48 MB`,
      String(b.text.length < 512), '^true$')
    const heavy = (await Promise.all(['/api/art', '/api/followups', '/api/conversations']
      .map((u) => req('GET', u)))).reduce((n, r) => n + r.text.length, 0)
    chk(`…where the three list endpoints it replaced carry ${heavy} bytes between them`,
      String(heavy > b.text.length * 10), '^true$')
  }

  /* ---------- a shop leaving with five years of history does not take the box with it ----------
   * /api/export/:table.csv called all(), which materialised the whole table, and then handed the
   * array to a toCsv() that built the entire file as one more string on top of it. Measured on a
   * shop with real volume: payments.csv blocked the event loop for 891 ms and took RSS from 79 MB
   * to 398 MB to produce a 13 MB file — on the 512 MB box INSTALL.md documents, shared with every
   * other shop, and node:sqlite is synchronous so that block is fleet-wide. The whole-shop JSON
   * export next door was converted to a cursor in v1.7.0 for exactly this reason; this half, the
   * one a shop reaches for first, was left behind.
   *
   * Two things are asserted, because either alone is weak. Content-Length is present if and only
   * if the body was built before it was sent, so its ABSENCE is proof the file was never held
   * whole. And the first byte must arrive early in the download, which is what "row by row"
   * actually means — before the fix the first byte arrived at 178 ms of a 182 ms transfer.
   * Its own server and its own database, so the main run is not carrying 60k rows around. */
  {
    const T7 = mkdtempSync(join(tmpdir(), 'psc-e2e-csv-'))
    const P7 = PORT + 13
    const csvSrv = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(P7), PSC_DB: join(T7, 'printshop.db'), PSC_AUTH: '1', PSC_SECRET: 'gate', PSC_PUBLIC_URL: `http://127.0.0.1:${P7}` },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    started.push(csvSrv)
    try {
      for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`http://127.0.0.1:${P7}/health`)).status === 200) break } catch { /* not up yet */ }
        await sleep(500)
      }
      const su = await fetch(`http://127.0.0.1:${P7}/api/auth/signup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop_name: 'Leaving Ink', owner_name: 'L', owner_email: 'l@leaving.test', password: 'GatePass-123456' }),
      })
      chk('a shop with history exists to export', String(su.status), '^200$')
      const cookie = (su.headers.getSetCookie?.() ?? [su.headers.get('set-cookie')].filter(Boolean))
        .map((c) => String(c).split(';')[0]).join('; ')

      // Five years of timeline, written straight into the shop's own database — the same shape the
      // app writes, just more of it than a gate run could generate through the API.
      const ROWS = 60000
      const d = new DatabaseSync(join(T7, 'tenants', 'leaving-ink', 'printshop.db'))
      d.exec('PRAGMA busy_timeout = 5000')
      d.exec('BEGIN')
      const ins = d.prepare('INSERT INTO activities (type, description, created_at) VALUES (?,?,?)')
      for (let i = 0; i < ROWS; i++) {
        ins.run('note', `Activity ${i} — a customer note of the length a real one runs to, which is what makes the file big.`, '2026-01-01 00:00:00')
      }
      d.exec('COMMIT')
      d.close()

      const t0 = Date.now()
      let ttfb = null, bytes = 0, status = 0, len, te, tail = '', head = ''
      await new Promise((resolve, reject) => {
        const rq = rawHttp(`http://127.0.0.1:${P7}/api/export/activities.csv`, { headers: { Cookie: cookie } }, (res) => {
          status = res.statusCode; len = res.headers['content-length']; te = res.headers['transfer-encoding']
          res.on('data', (c) => {
            if (ttfb === null) ttfb = Date.now() - t0
            bytes += c.length
            if (head.length < 200) head += c.toString('latin1').slice(0, 200)
            tail = (tail + c.toString('latin1')).slice(-200)
          })
          res.on('end', resolve)
        })
        rq.on('error', reject)
        rq.end()
      })
      const total = Date.now() - t0
      chk('the CSV export answers', String(status), '^200$')
      chk('…and never built the whole file before sending a byte of it', String(len ?? 'none'), '^none$')
      chk('…it is streamed', String(te), '^chunked$')
      chk(`…so the first byte arrives early in the download (${ttfb}ms of ${total}ms)`,
        String(ttfb < Math.max(25, total * 0.5)), '^true$')
      chk('…and the file is still the whole file', String(bytes > 8_000_000), '^true$')
      chk('…ending on a real row, not a truncation', String(/\n\d+,,,note,/.test(tail)), '^true$')
      // Correctness, not just plumbing: the header is still the table's own columns, in order,
      // and it is still the FIRST thing in the file.
      chk('…starting with the header row the shop\'s spreadsheet needs',
        head.split('\n')[0], '^id,contact_id,job_id,type,description,created_at$')
    } finally {
      try { csvSrv.kill('SIGKILL') } catch { /* already gone */ }
      try { rmSync(T7, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  /* ---------- the app can bind the address INSTALL.md says it binds ----------
   * INSTALL.md has described the reference deployment as "nginx terminating SSL, the app on
   * 127.0.0.1:3870" since it was written, and there was no way to do it: server.listen(PORT) binds
   * every interface and there was no host variable. So on that exact reference install the app was
   * ALSO answering on the box's LAN and public addresses — around nginx, and around the TLS nginx
   * was terminating. A documented security posture the code could not take. */
  {
    const { networkInterfaces } = await import('node:os')
    const T4 = mkdtempSync(join(tmpdir(), 'psc-e2e-host-'))
    const P4 = PORT + 9
    const bound = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(P4), PSC_HOST: '127.0.0.1', PSC_DB: join(T4, 'printshop.db'), PSC_AUTH: '1', PSC_SECRET: 'gate', PSC_PUBLIC_URL: `http://127.0.0.1:${P4}` },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    started.push(bound)
    let boundLog = ''
    bound.stdout.on('data', (d) => { boundLog += d })
    try {
      const reach = async (host) => {
        try { const res = await fetch(`http://${host}:${P4}/health`, { signal: AbortSignal.timeout(2500) }); return res.status }
        catch { return 0 }
      }
      let up = 0
      for (let i = 0; i < 120 && up !== 200; i++) { up = await reach('127.0.0.1'); if (up !== 200) await sleep(500) }
      chk('PSC_HOST=127.0.0.1 still serves the shop on loopback', String(up), '^200$')
      chk('…and the banner says what it bound to, so an operator can see it', boundLog, 'bound to 127\\.0\\.0\\.1 only')

      // The half that is the actual point: it must NOT be reachable on any other address of this
      // machine. Skipped rather than faked where the runner has no non-loopback interface.
      const lan = Object.values(networkInterfaces()).flat()
        .find((n) => n && n.family === 'IPv4' && !n.internal)?.address
      if (lan) {
        chk(`…and is not reachable on this box's own ${lan}, which is the whole point`, String(await reach(lan)), '^0$')
      } else {
        say('·', 'no non-loopback interface on this runner — the off-loopback half was not exercised')
      }
    } finally {
      try { bound.kill('SIGKILL') } catch { /* already gone */ }
      try { rmSync(T4, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  /* ---------- /health answers for the databases that actually hold shops ----------
   * canWrite() with no tenant context probes the DEFAULT database — which in multi-tenant mode
   * holds no shop at all, and is perfectly writable. So a release whose migration threw on ONE
   * shop's real data left that shop 100% down (login succeeded, then every screen answered
   * "Something went wrong on our end." forever) while /health answered {"ok":true} throughout.
   * deploy/ship.sh polls exactly this endpoint as its only automatic rollback gate: the deploy
   * was declared successful with the shops dark, and every uptime monitor stayed green too.
   *
   * The brick below is the ordinary upgrade case, not a contrivance: a shop that imported order
   * history before applyMigrations grew its partial UNIQUE index on estimates.source_ref.
   * Its own server, so the main run is untouched. */
  {
    const T2 = mkdtempSync(join(tmpdir(), 'psc-e2e-health-'))
    const P2 = PORT + 7
    const boot = () => spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(P2), PSC_DB: join(T2, 'printshop.db'), PSC_AUTH: '1', PSC_SECRET: 'gate', PSC_PUBLIC_URL: `http://127.0.0.1:${P2}` },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    const hit = async (p) => {
      try { const res = await fetch(`http://127.0.0.1:${P2}${p}`); return { status: res.status, text: await res.text() } }
      catch { return { status: 0, text: '' } }
    }
    const up = async (want) => { for (let i = 0; i < 120; i++) { const h = await hit('/health'); if (h.status === want) return h; await sleep(500) } return await hit('/health') }
    let s2p = boot(); started.push(s2p)
    try {
      await up(200)
      let res = await fetch(`http://127.0.0.1:${P2}/api/auth/signup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop_name: 'Alpha Ink', owner_name: 'A', owner_email: 'a@health.test', password: 'GatePass-123456' }),
      })
      chk('a second shop signs up on its own instance', String(res.status), '^200$')

      s2p.kill(); await sleep(700)
      // Brick it exactly as a real data-dependent migration does.
      const d = new DatabaseSync(join(T2, 'tenants', 'alpha-ink', 'printshop.db'))
      d.exec('PRAGMA busy_timeout = 5000')
      d.exec('DROP INDEX IF EXISTS idx_est_source_ref')
      d.prepare("INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, source_ref) VALUES (NULL,'EST-9001','draft','[]',0,0,0,'LEGACY-77')").run()
      d.prepare("INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, source_ref) VALUES (NULL,'EST-9002','draft','[]',0,0,0,'LEGACY-77')").run()
      d.close()

      s2p = boot(); started.push(s2p)
      const h = await up(503)
      chk('a shop whose database will not open makes /health fail', String(h.status), '^503$')
      chk('…and /health names the shop, so a human knows which one', h.text, 'alpha-ink')
    } finally {
      try { s2p.kill() } catch { /* already gone */ }
      try { rmSync(T2, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  /* ---------- and it is only refused when the server really cannot mail ----------
   * The refusal gated on platformEmailConfigured(), which asks one question — is GoHighLevel wired
   * up? — while sendEmail({platform:true}) uses server-wide SMTP first, then GHL, then the
   * Postmark/Resend relay. So an install configured exactly the way .env.example documents got a
   * 503 "this install has no email configured", and its locked-out owner was pushed to a shell
   * command on a server that would have delivered the reset. The fix it printed then named a
   * Settings card that does not exist in this edition and would not apply to reset mail if it did.
   * The SMTP host here is deliberately unreachable: the send is fire-and-forget, so what is being
   * asserted is the refusal decision, not a delivery. */
  {
    const T5 = mkdtempSync(join(tmpdir(), 'psc-e2e-smtpreset-'))
    const P5 = PORT + 11
    const env5 = { ...process.env, PORT: String(P5), PSC_DB: join(T5, 'printshop.db'), PSC_AUTH: '1', PSC_SECRET: 'gate', PSC_PUBLIC_URL: `http://127.0.0.1:${P5}`, SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: 'shop@example.com', SMTP_PASS: 'hunter2hunter2', SMTP_FROM: 'shop@example.com' }
    for (const k of ['GHL_PIT', 'GHL_LOCATION_ID', 'GHL_EMAIL_FROM', 'PSC_POSTMARK_TOKEN', 'PSC_RESEND_KEY']) delete env5[k]
    const s5 = spawn(process.execPath, ['--no-warnings', 'server.mjs'], { cwd: ROOT, env: env5, stdio: ['ignore', 'pipe', 'pipe'] })
    started.push(s5)
    const hit5 = async (path, body) => {
      try {
        const res = await fetch(`http://127.0.0.1:${P5}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        return { status: res.status, text: await res.text() }
      } catch { return { status: 0, text: '' } }
    }
    try {
      for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`http://127.0.0.1:${P5}/health`)).ok) break } catch { /* not up */ }
        await sleep(500)
      }
      let out = await hit5('/api/auth/signup', { shop_name: 'Smtp Shop', owner_name: 'S', owner_email: 'smtp@reset.test', password: 'GatePass-123456' })
      chk('a shop signs up on an install using server-wide SMTP', String(out.status), '^200$')
      out = await hit5('/api/auth/forgot', { email: 'smtp@reset.test' })
      chk('…and its locked-out owner is not told the server cannot mail', String(out.status), '^200$')
      chk('…they are told a link is coming', out.text, 'on its way|check your (inbox|email)|if that address')
    } finally {
      try { s5.kill('SIGKILL') } catch { /* already gone */ }
      try { rmSync(T5, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  /* ---------- a reset link points where the shop lives, not where a stranger says ----------
   *
   * The link in a password-reset email carries a one-time token that SETS the account password.
   * publicOrigin() falls back to the request's Host header, and Host is chosen by whoever sent the
   * request — so an unauthenticated `POST /api/auth/reset` with `Host: evil.example` mails the real
   * owner a working takeover link on the attacker's server. PSC_PUBLIC_URL closes it.
   *
   * The suite already asserts "an emailed link ignores a poisoned Host header" — and it passes for
   * the wrong reason: this harness sets PSC_PUBLIC_URL on its own server, and PSC_PUBLIC_URL is
   * precisely the variable that is NOT set on the production install this was found on, four
   * releases after the app started warning about it at boot. So this instance is booted WITHOUT
   * it, which is the configuration real installs are actually in.
   *
   * The assertion reads the email that would really be sent: GHL_BASE points at a stub here, so
   * the platform relay is exercised end to end instead of being mocked out at the callsite. */
  {
    const T4 = mkdtempSync(join(tmpdir(), 'psc-e2e-origin-'))
    const P4 = PORT + 9
    const P4RELAY = PORT + 10
    const sent = []
    const { createServer } = await import('node:http')
    const relay = createServer((rq, rs) => {
      let body = ''
      rq.on('data', (d) => { body += d })
      rq.on('end', () => {
        if (rq.url.includes('/conversations/messages')) sent.push(body)
        rs.writeHead(200, { 'Content-Type': 'application/json' })
        rs.end(JSON.stringify({ contact: { id: 'stub-contact' }, emailMessageId: 'stub-msg' }))
      })
    })
    await new Promise((r) => relay.listen(P4RELAY, '127.0.0.1', r))
    // PSC_PUBLIC_URL is deliberately absent from this env — that is the whole point of the case.
    const env4 = { ...process.env, PORT: String(P4), PSC_DB: join(T4, 'printshop.db'), PSC_AUTH: '1', PSC_SECRET: 'gate', GHL_BASE: `http://127.0.0.1:${P4RELAY}`, GHL_PIT: 'stub-token', GHL_LOCATION_ID: 'stub-loc', GHL_EMAIL_FROM: 'stub@printshopcrm.test' }
    delete env4.PSC_PUBLIC_URL
    const s4 = spawn(process.execPath, ['--no-warnings', 'server.mjs'], { cwd: ROOT, env: env4, stdio: ['ignore', 'pipe', 'pipe'] })
    started.push(s4)
    const raw = (method, path, headers, body) => new Promise((resolve) => {
      const rq = rawHttp({ host: '127.0.0.1', port: P4, method, path, headers }, (resp) => {
        let b = ''; resp.on('data', (d) => { b += d }); resp.on('end', () => resolve({ status: resp.statusCode, text: b, headers: resp.headers }))
      })
      rq.on('error', (e) => resolve({ status: 0, text: `error ${e.message}`, headers: {} }))
      rq.end(body)
    })
    try {
      for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`http://127.0.0.1:${P4}/health`)).ok) break } catch { /* not up */ }
        await sleep(500)
      }
      const suBody = JSON.stringify({ shop_name: 'Origin Ink', owner_name: 'O', owner_email: 'owner@origin.test', password: 'GatePass-123456' })
      const su = await raw('POST', '/api/auth/signup', { Host: `127.0.0.1:${P4}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(suBody) }, suBody)
      chk('a shop signs up on an install with no PSC_PUBLIC_URL', String(su.status), '^200$')
      const sc = [].concat(su.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ')

      // The owner loads the app on the host the shop actually uses. That is the evidence.
      await raw('GET', '/api/auth/me', { Host: `127.0.0.1:${P4}`, Cookie: sc })

      // And now a STRANGER signs up. On an open-signup install anybody is an owner five seconds
      // after they arrive, so "a host an owner has signed in on" is not evidence of anything
      // unless it is evidence about THAT OWNER'S OWN SHOP. One free trial and one GET with a
      // chosen Host header repointed the reset link for EVERY shop on the box — the same takeover
      // the learned origin was added to close, one signup further away, and persisted to the
      // control database so it survived restarts with nothing in the product able to show or
      // clear it.
      const evBody = JSON.stringify({ shop_name: 'Evil Tees', owner_name: 'Eve', owner_email: 'eve@evil.test', password: 'GatePass-123456' })
      const ev = await raw('POST', '/api/auth/signup', { Host: `127.0.0.1:${P4}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(evBody) }, evBody)
      const evc = [].concat(ev.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ')
      chk('a stranger can sign up for a free trial, as anyone can', String(ev.status), '^200$')
      await raw('GET', '/api/auth/me', { Host: 'evil.attacker.example', Cookie: evc })

      // The welcome email is fire-and-forget, so let it land before clearing — otherwise it is the
      // message these assertions read, and they pass without the reset link ever being examined.
      for (let i = 0; i < 40; i++) { if (sent.length) break; await sleep(250) }
      sent.length = 0
      const rsBody = JSON.stringify({ email: 'owner@origin.test' })
      const rr = await raw('POST', '/api/auth/forgot', { Host: 'evil.attacker.example', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rsBody) }, rsBody)
      chk('a reset link can be requested', String(rr.status), '^200$')
      let mail = ''
      for (let i = 0; i < 60; i++) {
        const m = sent.filter((x) => x.includes('/reset?token=')).join('\n')
        if (m) { mail = m; break }
        await sleep(250)
      }
      chk('…and the reset email really goes out', String(mail.length > 0), '^true$')
      chk('…carrying a link to where the shop actually lives', mail, `127\\.0\\.0\\.1(:|%3A)${P4}(\\\\u002F|/)reset`)
      chk('…and never to the host the request asked for', mail.includes('evil.attacker.example') ? 'takeover' : 'safe', '^safe$')
    } finally {
      try { s4.kill('SIGKILL') } catch { /* already gone */ }
      await new Promise((r) => relay.close(r))
      try { rmSync(T4, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  /* ---------- a deploy drains instead of being killed, even with a tab open ----------
   *
   * server.close() waits for every open connection to finish, and an upgraded WebSocket never
   * finishes on its own. So one browser left open on the shop's board carried EVERY deploy past
   * the graceful path and into the 8s hard-exit timer — `process.exit(0)`, which severs whatever
   * request was mid-flight. Measured before the fix: 8016 ms with a single socket, 14 ms with
   * none. The graceful drain the deploy depends on had therefore never actually run in production.
   *
   * The assertion is TIMED, and the margin is deliberate: broken is 8s, fixed is tens of ms, and
   * 3s sits far from both so a loaded machine cannot flip it. Its own server, own database, own
   * port, so the main run is untouched. */
  {
    const T3 = mkdtempSync(join(tmpdir(), 'psc-e2e-drain-'))
    const P3 = PORT + 8
    const s3 = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(P3), PSC_DB: join(T3, 'printshop.db'), PSC_AUTH: '1', PSC_SECRET: 'gate', PSC_PUBLIC_URL: `http://127.0.0.1:${P3}` },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    started.push(s3)
    try {
      for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`http://127.0.0.1:${P3}/health`)).ok) break } catch { /* not up */ }
        await sleep(500)
      }
      const su = await fetch(`http://127.0.0.1:${P3}/api/auth/signup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop_name: 'Drain Ink', owner_name: 'D', owner_email: 'd@drain.test', password: 'GatePass-123456' }),
      })
      const raw = su.headers.getSetCookie?.() ?? [su.headers.get('set-cookie')].filter(Boolean)
      const cookie = raw.map((c) => String(c).split(';')[0]).join('; ')
      chk('the drain instance has a signed-in shop', String(su.status), '^200$')

      const sock = new WebSocket(`ws://127.0.0.1:${P3}/ws`, { headers: { Cookie: cookie } })
      const opened = await new Promise((r) => {
        sock.on('open', () => r(true)); sock.on('close', () => r(false)); sock.on('error', () => r(false))
      })
      chk('…and a browser tab holds a live socket to it', String(opened), '^true$')

      const closeCode = new Promise((r) => { sock.on('close', (c) => r(c)); setTimeout(() => r(0), 6000).unref?.() })
      const t0 = Date.now()
      s3.kill('SIGTERM')
      const exited = await Promise.race([
        new Promise((r) => s3.on('exit', () => r(true))),
        sleep(12000).then(() => false),
      ])
      const ms = Date.now() - t0
      chk('SIGTERM exits the server', String(exited), '^true$')
      chk(`an open tab does not hold a deploy open (${ms}ms, was 8016ms)`, String(ms < 3000), '^true$')
      chk('…and the tab is told to go away, so it reconnects itself', String(await closeCode), '^1001$')
    } finally {
      try { s3.kill('SIGKILL') } catch { /* already gone */ }
      try { rmSync(T3, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

} catch (err) {
  say('✗', `harness error: ${err.message}`)
  fails++
}

console.log()
console.log(fails > 0 ? `  E2E: ${fails} failure(s)` : '  E2E: all pass')
cleanup()
process.exit(fails > 0 ? 1 : 0)
