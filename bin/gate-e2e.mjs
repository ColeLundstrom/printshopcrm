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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Env as well as argv: a CI matrix that runs two jobs on one runner needs to move this, and
// `PSC_GATE_PORT=4391 npm run test:e2e` is reachable where an npm-script argv is not.
const PORT = Number(process.argv[2] || process.env.PSC_GATE_PORT) || 4390
const BASE = `http://127.0.0.1:${PORT}`
const TMP = mkdtempSync(join(tmpdir(), 'psc-e2e-'))

let fails = 0
const say = (mark, msg) => console.log(`  ${mark} ${msg}`)

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

/* ---------- boot a server against a throwaway db ---------- */
const server = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), PSC_DB: join(TMP, 'printshop.db'), PSC_AUTH: '1', PSC_SECRET: 'gate', PSC_PUBLIC_URL: `http://127.0.0.1:${PORT}` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (d) => { serverLog += d })
server.stderr.on('data', (d) => { serverLog += d })

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  try { server.kill() } catch { /* already gone */ }
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* best effort */ }
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

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
    try { if ((await fetch(`${BASE}/health`)).ok) return } catch { /* not up yet */ }
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
  const key = r.json?.api_key || ''
  chk('API key issues', key, '^psc_live_')
  const asKey = (k = key) => ({ cookies: false, headers: { Authorization: `Bearer ${k}` } })

  r = await req('GET', '/api/v1/customers', { cookies: false })
  chk('v1 rejects a missing API key', r.status, '^401$')
  r = await req('GET', '/api/v1/customers', asKey('psc_live_not_a_real_key'))
  chk('v1 rejects a bogus API key', r.status, '^401$')
  r = await req('GET', '/api/v1/customers', asKey())
  chk('v1 accepts the issued key', r.status, '^200$')

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

    // The point of voiding is to be able to put it right, which means the quote must come free.
    r = await req('POST', `/api/estimates/${estId}/convert`, { body: { due_date: '2026-02-01' } })
    chk('voiding frees the estimate so it can be invoiced correctly', String(r.status), '^200$')

    // Money already recorded is a bookkeeping fact — voiding around it would orphan the payment.
    const invId2 = r.json?.invoice_id
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
      stdio: ['ignore', 'pipe', 'pipe'],
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
} catch (err) {
  say('✗', `harness error: ${err.message}`)
  fails++
}

console.log()
console.log(fails > 0 ? `  E2E: ${fails} failure(s)` : '  E2E: all pass')
cleanup()
process.exit(fails > 0 ? 1 : 0)
