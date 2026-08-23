#!/usr/bin/env node
/**
 * The improvement loop — "check, fix, verify, report", the way a careful employee would.
 *
 *   node bin/improve.mjs --target https://pro.printshopcrm.com
 *
 * It runs a suite of checks against a running instance and writes a report. It does not attempt
 * repairs: every failure here is a config or code regression that wants a human and a diff, and a
 * tool that half-fixes production is worse than one that reports precisely.
 *
 * ON DEPLOYING: it deliberately does NOT deploy. The workspace rule is that nothing ships without
 * an authorised person saying so, and an unattended loop that edits a live multi-tenant CRM is
 * exactly the thing that rule exists to prevent. The loop's job ends at the report.
 *
 * Exit codes: 0 = all clear, 1 = failures remain, 2 = the loop itself broke.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true) : d }
const TARGET = String(flag('target', 'http://localhost:3870')).replace(/\/$/, '')
const JSON_OUT = !!flag('json', false)
const REPORT_DIR = String(flag('out', '/tmp/psc-improve'))

const log = (...a) => { if (!JSON_OUT) console.log(...a) }

async function req(path, { method = 'GET', headers = {}, body, redirect = 'manual' } = {}) {
  const ctl = AbortSignal.timeout(15000)
  const r = await fetch(`${TARGET}${path}`, { method, headers, body, redirect, signal: ctl })
  const text = await r.text().catch(() => '')
  return { status: r.status, headers: r.headers, text }
}

/**
 * Each check answers one question and says what a failure means. `fix` is present only where a
 * safe, well-understood remedy exists — everything else is reported for a human, on purpose.
 */
const CHECKS = [
  {
    id: 'service-up', severity: 'critical',
    what: 'The app answers at all',
    async run() {
      const r = await req('/health')
      return r.status === 200 ? { ok: true } : { ok: false, detail: `/health returned ${r.status}` }
    },
  },
  {
    id: 'security-headers', severity: 'high',
    what: 'Security response headers are present',
    async run() {
      const r = await req('/')
      const want = ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options']
      const missing = want.filter((h) => !r.headers.get(h))
      if (r.headers.get('x-powered-by')) missing.push('x-powered-by should be disabled')
      return missing.length ? { ok: false, detail: `missing: ${missing.join(', ')}` } : { ok: true }
    },
  },
  {
    id: 'hsts', severity: 'medium',
    what: 'HSTS is asserted over TLS',
    async run() {
      if (!TARGET.startsWith('https://')) return { ok: true, skipped: 'not TLS' }
      const r = await req('/')
      return r.headers.get('strict-transport-security') ? { ok: true } : { ok: false, detail: 'no Strict-Transport-Security' }
    },
  },
  {
    id: 'embed-framable', severity: 'high',
    what: 'The shop-side embed can still be iframed',
    async run() {
      const r = await req('/embed/gangsheet?shop=probe')
      const csp = r.headers.get('content-security-policy') || ''
      if (r.headers.get('x-frame-options')) return { ok: false, detail: 'X-Frame-Options set on /embed — this breaks every shop\'s gang-sheet iframe' }
      return /frame-ancestors \*/.test(csp) ? { ok: true } : { ok: false, detail: 'embed CSP no longer allows cross-origin framing' }
    },
  },
  {
    id: 'auth-gate', severity: 'critical',
    what: 'Unauthenticated API calls are refused',
    async run() {
      const r = await req('/api/contacts')
      return r.status === 401 ? { ok: true } : { ok: false, detail: `/api/contacts returned ${r.status} without a session (expected 401)` }
    },
  },
  {
    id: 'login-throttle', severity: 'high',
    what: 'Repeated bad logins get throttled',
    async run() {
      const email = `loop-probe-${Date.now()}@example.invalid`
      let saw429 = false
      for (let i = 0; i < 7 && !saw429; i++) {
        const r = await req('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'wrong' }) })
        if (r.status === 429) saw429 = true
      }
      return saw429 ? { ok: true } : { ok: false, detail: 'seven bad logins never tripped a 429' }
    },
  },
  {
    id: 'slack-signature', severity: 'high',
    what: 'Slack endpoints reject unsigned requests',
    async run() {
      const r = await req('/api/slack/probe-key/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"url_verification","challenge":"x"}' })
      // 404 (no such shop) and 401 (bad signature) are both correct refusals; 200 is not.
      return [401, 404, 400].includes(r.status) ? { ok: true } : { ok: false, detail: `unsigned Slack call returned ${r.status}` }
    },
  },
  {
    id: 'signup-honeypot', severity: 'medium',
    what: 'Bot signups are swallowed',
    async run() {
      const r = await req('/api/auth/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop_name: 'Probe', owner_name: 'Probe', owner_email: `probe-${Date.now()}@example.invalid`, password: 'ProbePass-12345', website: 'http://spam.example' }),
      })
      if (r.status !== 200) return { ok: false, detail: `honeypot signup returned ${r.status}` }
      const slug = (() => { try { return JSON.parse(r.text).slug } catch { return null } })()
      return slug === 'pending' ? { ok: true } : { ok: false, detail: 'honeypot signup appears to have created a real shop' }
    },
  },
  {
    id: 'marketing-funnel', severity: 'medium',
    what: 'The marketing site still points at signup',
    async run() {
      if (!TARGET.includes('printshopcrm.com')) return { ok: true, skipped: 'only meaningful against production' }
      const r = await fetch('https://printshopcrm.com/', { signal: AbortSignal.timeout(15000) })
      const html = await r.text()
      const hasCta = /pro\.printshopcrm\.com\/signup/.test(html)
      return hasCta ? { ok: true } : { ok: false, detail: 'pre-JS homepage has no /signup link — crawlers and no-JS visitors see a dead end' }
    },
  },
  {
    id: 'quote-chain', severity: 'high',
    what: 'A pasted request still parses to a quantity, a style and a priced blank',
    async run() {
      // This one inspects the SHIPPING CODE rather than the remote target: the quote chain fails
      // quietly — a bad parse yields no estimate at all, and a bad style match yields a real-
      // looking price for the wrong garment. Both have happened. No network, no credentials.
      const { parseIntakeHeuristic } = await import('../lib/ai.mjs')
      const { parseGarmentText } = await import('../lib/suppliers.mjs')
      const cases = [
        { text: '144 Bella+Canvas 3001 in White, 1 color front', qty: 144, style: '3001' },
        { text: '200 Gildan 5000 tees in Black, 2 color front', qty: 200, style: '5000' },
        { text: '500 x Gildan 18500 hoodies in Navy', qty: 500, style: '18500' },
        { text: '72 Comfort Colors 1717 in Blue', qty: 72, style: '1717' },
      ]
      const bad = []
      for (const c of cases) {
        const o = parseIntakeHeuristic(c.text)
        const g = parseGarmentText(c.text)
        if (o.total_pieces !== c.qty) bad.push(`${JSON.stringify(c.text)} → qty ${o.total_pieces}, wanted ${c.qty}`)
        if (g.style !== c.style) bad.push(`${JSON.stringify(c.text)} → style ${JSON.stringify(g.style)}, wanted ${c.style}`)
      }
      return bad.length ? { ok: false, detail: bad.join('; ') } : { ok: true, detail: `${cases.length} intake cases parse correctly` }
    },
  },
]

async function runAll() {
  const results = []
  for (const c of CHECKS) {
    const started = Date.now()
    try {
      const r = await c.run()
      results.push({ id: c.id, what: c.what, severity: c.severity, ...r, ms: Date.now() - started })
    } catch (e) {
      results.push({ id: c.id, what: c.what, severity: c.severity, ok: false, detail: `check errored: ${e.message}`, ms: Date.now() - started })
    }
  }
  return results
}

const icon = (r) => (r.skipped ? '–' : r.ok ? '✓' : '✗')

;(async () => {
  log(`\n  Improvement loop → ${TARGET}\n`)
  const results = await runAll()
  for (const r of results) log(`  ${icon(r)} ${r.what}${r.skipped ? ` (skipped: ${r.skipped})` : r.ok ? '' : `\n      ${r.detail}`}`)

  const still = results.filter((r) => !r.ok && !r.skipped)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  mkdirSync(REPORT_DIR, { recursive: true })
  const ran = results.filter((r) => !r.skipped)
  const report = { target: TARGET, at: new Date().toISOString(), passed: ran.filter((r) => r.ok).length, failed: still.length, skipped: results.length - ran.length, results }
  const path = join(REPORT_DIR, `improve-${stamp}.json`)
  writeFileSync(path, JSON.stringify(report, null, 2))

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); process.exit(still.length ? 1 : 0) }

  log(`\n  ${report.passed} passed, ${still.length} failed, ${report.skipped} skipped → ${path}`)
  if (still.length) {
    log('\n  Needs a human:')
    for (const r of still) log(`   [${r.severity}] ${r.what} — ${r.detail}`)
    log('\n  Nothing was deployed. Review, fix, and deploy when you decide to.\n')
  } else {
    log('\n  All clear.\n')
  }
  process.exit(still.length ? 1 : 0)
})().catch((e) => { console.error('improve loop failed:', e); process.exit(2) })
