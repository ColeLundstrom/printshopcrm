import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const viewFiles = () => readdirSync(join(ROOT, 'public/js/views')).filter((f) => f.endsWith('.js')).map((f) => `public/js/views/${f}`)
const clientFiles = () => [...viewFiles(), 'public/js/app.js', 'public/js/core.js', 'public/js/art-production.js',
  ...readdirSync(join(ROOT, 'public/js/shared')).filter((f) => f.endsWith('.js')).map((f) => `public/js/shared/${f}`)]

test('empty() draws a sprite in a tinted disc, maps the old glyphs and still escapes anything else', async () => {
  const { empty, icon } = await import('../public/js/core.js')
  const html = empty('check', 'All <done>', 'Nothing & nobody', '<a class="btn">Go</a>')
  assert.match(html, /<div class="big ic-check" aria-hidden="true"><svg class="ico"[^>]*><use href="#i-check"><\/use><\/svg><\/div>/)
  assert.match(html, /<h3>All &lt;done&gt;<\/h3><p>Nothing &amp; nobody<\/p><a class="btn">Go<\/a>/)
  // Callers in files other agents own still pass glyphs; they render as the matching sprite.
  assert.match(empty('▤', 'No estimates', ''), /#i-estimates/)
  assert.match(empty('◉', 'No customers', ''), /#i-customers/)
  // Something that is neither a sprite name nor a known glyph is text, escaped, never a <use>.
  const odd = empty('<b>', 't', 'm')
  assert.doesNotMatch(odd, /<use/); assert.match(odd, /&lt;b&gt;/)
  assert.equal(icon('alert', 'ico ico-inline'), '<svg class="ico ico-inline" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><use href="#i-alert"></use></svg>')
})

test('every sprite icon the client references exists in the shell sprite', () => {
  const shell = read('public/index.html')
  const defined = new Set([...shell.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]))
  for (const name of ['check', 'x', 'alert', 'sidebar', 'scan', 'cart', 'ledger', 'code', 'camera', 'clock']) assert.ok(defined.has(name), `#i-${name} should be defined`)
  const used = new Map()
  for (const f of clientFiles()) {
    const src = read(f)
    for (const re of [/#i-([a-z][a-z0-9-]*)/g, /\bicon\('([a-z][a-z0-9-]*)'/g, /\bempty\('([a-z][a-z0-9-]*)'/g, /\bico: ?'([a-z][a-z0-9-]*)'/g]) {
      for (const m of src.matchAll(re)) used.set(m[1], f)
    }
  }
  assert.ok(used.size > 20, 'sanity: the scan should find the nav and empty-state icons')
  for (const [name, file] of used) assert.ok(defined.has(name), `${file} uses #i-${name}, which index.html does not define`)
  // Duplicated nav icons were the point of item 17: these four now have their own.
  const app = read('public/js/app.js')
  assert.match(app, /href: '\/scan', ico: 'scan'/); assert.match(app, /href: '\/purchasing', ico: 'cart'/)
  assert.match(app, /href: '\/books', ico: 'ledger'/); assert.match(app, /href: '\/developers', ico: 'code'/)
  assert.match(app, /\{ href: '\/tv', ico: 'tv', name: 'Shop TV' \}/, 'Shop TV stays in the nav')
})

test('no native prompt/confirm, and confirmModal is never awaited as if it returned a promise', () => {
  for (const f of clientFiles()) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.doesNotMatch(src, /(?<![\w.])(?:window\.)?(?:prompt|confirm)\(/, `${f} uses a native prompt()/confirm()`)
    assert.doesNotMatch(src, /await\s+confirmModal\(/, `${f} awaits confirmModal, which takes a callback`)
  }
  const payments = read('public/js/views/payments.js')
  assert.match(payments, /confirmModal\('Remove payment credentials\?',[^]*?async\s*\(\)\s*=>[^]*?disconnect\/payments/, 'the disconnect runs in the confirm callback')
})

test('send toasts only claim an email when one is connected', () => {
  const inv = read('public/js/views/invoices.js')
  assert.match(inv, /out\?\.email_live && out\?\.emailed_to \?/)
  assert.match(inv, /r\.email_live \?[^:]+: 'Marked sent\. No email connected yet, copy the pay link to send it'/)
  assert.doesNotMatch(inv, /r\.delivered \? 'Payment link emailed to the customer'/)
  const ap = read('public/js/views/autopilot.js')
  assert.match(ap, /r\.email_live === false/)
  assert.match(ap, /email_live: c\.email_live/)
  const server = read('server.mjs')
  const reqPay = server.slice(server.indexOf("app.post('/api/invoices/:id/request-payment'"), server.indexOf("app.post('/api/invoices/:id/request-payment'") + 2600)
  assert.match(reqPay, /email_live: notifyStatus\(s\)\.shop_email/)
  const commit = server.slice(server.indexOf("app.post('/api/autopilot/commit'"), server.indexOf("app.post('/api/autopilot/commit'") + 900)
  assert.match(commit, /email_live: notifyStatus\(getSettings\(\)\)\.shop_email/)
})

test('board recount keeps the empty-column placeholder in step with the cards', async () => {
  const mkCol = (cards, hint) => {
    const body = {
      kids: [...Array(cards)].map(() => ({ cls: 'jcard' })).concat(hint ? [{ cls: 'col-empty', remove() { body.kids = body.kids.filter((k) => k !== this) } }] : []),
      querySelector(sel) { return sel === '.col-empty' ? this.kids.find((k) => k.cls === 'col-empty') || null : null },
      insertAdjacentHTML(_where, html) { assert.match(html, /Drop a job here/); const k = { cls: 'col-empty', remove() { body.kids = body.kids.filter((x) => x !== k) } }; this.kids.push(k) },
    }
    const ct = { textContent: '' }
    return { body, ct, querySelector: (s) => (s === '.ct' ? ct : s === '.col-b' ? body : null), querySelectorAll: (s) => (s === '.jcard' ? body.kids.filter((k) => k.cls === 'jcard') : []) }
  }
  const emptied = mkCol(0, false), landed = mkCol(1, true), steady = mkCol(2, false)
  const prevDoc = globalThis.document
  globalThis.document = { querySelectorAll: (s) => (s === '.col' ? [emptied, landed, steady] : []), querySelector: () => null }
  try {
    const { recount } = await import('../public/js/views/board.js')
    recount()
  } finally { globalThis.document = prevDoc }
  assert.equal(emptied.ct.textContent, 0); assert.ok(emptied.body.querySelector('.col-empty'), 'a column that lost its last job says so')
  assert.equal(landed.ct.textContent, 1); assert.equal(landed.body.querySelector('.col-empty'), null, 'the column a job landed in drops its placeholder')
  assert.equal(steady.ct.textContent, 2); assert.equal(steady.body.querySelector('.col-empty'), null)
})

test('onboarding quote step has one Skip and a Continue, and its sample date is never in the past', () => {
  const src = read('public/js/views/onboarding.js')
  assert.doesNotMatch(src, /foot\('Skip for now'/, 'the main button must not read "Skip for now" beside the Skip button')
  assert.match(src, /\$\{foot\('Continue', true\)\}`\n\n  if \(key === 'basics'\)/)
  const sample = src.slice(src.indexOf('const sampleRequest'), src.indexOf('const FLOW'))
  assert.doesNotMatch(sample, /\d{4}-\d{2}-\d{2}/, 'the sample request must not hard-code a date')
  assert.match(sample, /\$\{sampleInHand\(\)\}/)
  assert.match(src, /new Date\(now\.getFullYear\(\), now\.getMonth\(\), now\.getDate\(\) \+ 21\)/)
})

test('single-tenant agent keys and non-admin Control Room render explanations, not raw errors', () => {
  const keys = read('public/js/views/agent-keys.js')
  assert.match(keys, /window\.__me\?\.single_tenant\)return unavailable\(\)/)
  assert.match(keys, /Agent connections need shop sign-in/)
  assert.match(read('public/js/views/setup.js'), /window\.__me\?\.single_tenant \? '' : '<p><a class="btn ghost" href="#\/agent-keys">/)
  const admin = read('public/js/views/admin.js')
  assert.doesNotMatch(admin, /<div class="empty">\$\{esc\(e\.message \|\| 'Admins only'\)\}<\/div>/)
  assert.match(admin, /Control Room is for the deployment admin/)
  assert.doesNotMatch(admin, /#ef4444/)
})

test('theme-dependent colours come from tokens, and the light palettes agree', () => {
  const css = read('public/css/app.css')
  for (const rule of ['.pill.green', '.pill.amber', '.pill.red', '.pill.blue', '.tag.green', '.tag.amber', '.tag.red', '.btn.danger']) {
    const line = css.split('\n').find((l) => l.startsWith(rule + ' {'))
    assert.ok(line, `${rule} still exists`)
    assert.doesNotMatch(line, /rgba\(/, `${rule} must mix its tint from the theme token`)
    assert.match(line, /color-mix\(in srgb, var\(--/)
  }
  assert.match(css, /^\.btn\.primary \{/m); assert.match(css, /^\.btn\.secondary \{/m)
  assert.doesNotMatch(css, /#1a1d22 0% 25%/, 'the checkerboard follows the theme')
  for (const f of ['public/js/views/board.js', 'public/js/views/pipeline.js']) {
    const line = read(f).split('\n').find((l) => l.startsWith('const STAGE_COLOR'))
    assert.doesNotMatch(line, /#[0-9a-f]{3,6}/i, `${f} stage colours must be tokens`)
  }
  assert.doesNotMatch(read('public/js/views/onboarding.js'), /var\(--muted/)
  const lightAccent = /:root\[data-theme="light"\] \{[^}]*--accent: (#[0-9a-f]+);/i.exec(css)[1]
  const auth = read('public/auth.html')
  assert.match(auth, new RegExp(`:root, :root\\[data-theme="light"\\] \\{[^}]*--accent:${lightAccent};`, 'i'), 'auth.html light accent matches the app')
  assert.match(auth, /__SOURCE_LINK__/, 'the AGPL source offer placeholder stays')
  const brand = read('public/js/shop-branding.js')
  assert.match(brand, /meta\[name="theme-color"\]/); assert.match(brand, /setTheme\(next\)/)
})

test('the sidebar toggle is a compact icon button with an accessible name', () => {
  const shell = read('public/index.html')
  assert.match(shell, /<button class="desktop-nav-toggle icon-btn" id="desktop-nav-toggle" type="button" aria-controls="sidebar" aria-expanded="true" aria-label="Hide navigation"[^>]*><svg class="ico"[^>]*><use href="#i-sidebar"><\/use><\/svg><\/button>/)
})

test('the router paints a skeleton on entering a view but not on a realtime re-run of the same view', () => {
  const core = read('public/js/core.js')
  const rr = core.slice(core.indexOf('export async function runRouter()'), core.indexOf('export function setPage('))
  assert.match(rr, /if \(view && r\.handler !== lastHandler\) view\.innerHTML = skeleton\(/)
  assert.ok(rr.indexOf('skeleton(') < rr.indexOf('await r.handler('), 'the skeleton goes up before the handler awaits anything')
  assert.match(rr, /404|Back to Today/)
  assert.match(core, /href="#\/">Back to Today<\/a>/)
  for (const f of ['board', 'pipeline', 'automations', 'developers', 'followups', 'today']) {
    assert.doesNotMatch(read(`public/js/views/${f}.js`), /'<div class="dim">Loading[^']*<\/div>'/, `${f}.js keeps an ad-hoc Loading string`)
  }
})

test('boot reads the preferred department from /api/auth/me and navigation refreshes badges, not settings', () => {
  const app = read('public/js/app.js')
  const boot = app.slice(app.indexOf('async function boot()'), app.indexOf('function bootFailed'))
  assert.doesNotMatch(boot, /api\.get\('\/api\/production'\)/, 'boot must not load the whole production queue')
  assert.match(boot, /me\.preferred_department/)
  const nav = app.slice(app.indexOf('async function navigate()'), app.indexOf("window.addEventListener('hashchange', navigate)"))
  assert.doesNotMatch(nav, /refreshChrome\(\)/, 'a click must not refetch /api/settings')
  assert.match(nav, /if \(chromeFresh\) chromeFresh = false\s*else refreshBadges\(\)/)
  assert.match(app, /m\.type === 'branding'\) \{\s*refreshChrome\(\)/, 'branding changes still re-read settings')
  assert.match(app, /addEventListener\('psc:settings', refreshChrome\)/, 'saving Settings still re-reads settings')
  assert.match(read('server.mjs'), /preferred_department: req\.member \?/)
})
