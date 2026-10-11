#!/usr/bin/env node
/** Books & A/R browser evidence, only against a freshly created synthetic demo. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHttpTestServer } from '../helpers/http-test-server.mjs'
import { isolateBrowser, redact, requestLabel } from './isolation.mjs'
import { seedReceivablesReview, receivablesSnapshot } from './receivables-fixture.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const artifacts = join(root, 'browser-artifacts')
const tool = join(root, '.browser-tools/node_modules/playwright/index.mjs')
const secrets = []
const report = { browser: 'Official Google Chrome, sandbox enabled', browserChannel: 'chrome',
  sourceRevision: process.env.GITHUB_SHA || null, nodeVersion: process.version,
  data: 'Disposable synthetic demo; no production data or services', scenarios: [],
  realtimeCoverage: 'The exact local /ws endpoint is stubbed. Real realtime connectivity and delivery are not tested.' }
let server, browser, temp, db

async function check(scenario, name, action) {
  try { await action(); scenario.checks.push({ name, status: 'passed' }); console.log('  PASS ' + name) }
  catch (error) { scenario.checks.push({ name, status: 'failed', error: redact(error.stack || error, secrets) }); throw error }
}
async function screenshot(page, scenario, name) {
  assert.equal(new URL(page.url()).pathname, '/', 'Only the authenticated synthetic app may be captured')
  await page.evaluate(() => window.scrollTo(0, 0))
  const filename = `receivables-${scenario.name}-${name}.png`
  await page.screenshot({ path: join(artifacts, filename), fullPage: true, animations: 'disabled', mask: [page.locator('input[type="password"]')] })
  scenario.screenshots.push(filename)
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function deadline(promise, ms, message) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms) })]) }
  finally { clearTimeout(timer) }
}

// Delay one genuine, read-only response from this exact demo origin, so browser Back/Forward
// can exercise the stale-response fence without replacing application code or faking totals.
async function holdNextReport(page, scenario) {
  const url = server.base + '/api/reports/ar-aging', ready = deferred(), release = deferred(), pending = new Set()
  void ready.promise.catch(() => {})
  const handler = route => {
    const work = (async () => {
      assert.equal(route.request().method(), 'GET')
      assert.equal(route.request().url(), url)
      const response = await route.fetch({ maxRedirects: 0, timeout: 15000 })
      assert.equal(response.status(), 200, 'The delayed report must be a real successful response')
      ready.resolve()
      await release.promise
      await route.fulfill({ response })
    })().catch(async error => {
      ready.reject(error)
      scenario.networkErrors.push(redact('Delayed report: ' + String(error), secrets))
      try { await route.abort('failed') } catch (abortError) { scenario.networkErrors.push(redact(String(abortError), secrets)) }
    })
    pending.add(work)
    void work.then(() => pending.delete(work))
    return work
  }
  await page.route(url, handler, { times: 1 })
  return {
    ready: () => deadline(ready.promise, 15000, 'The report request did not reach the delay fixture'),
    async close() { release.resolve(); await page.unroute(url, handler); await Promise.all([...pending]) },
  }
}

async function exercise(viewport, ownerCookie, neighborCookie) {
  const scenario = { name: viewport.name, viewport: { width: viewport.width, height: viewport.height },
    checks: [], screenshots: [], consoleErrors: [], pageErrors: [], blockedRequests: [], networkErrors: [], unexpectedWrites: [], mockedWebSockets: [] }
  report.scenarios.push(scenario)
  const context = await browser.newContext({ viewport: scenario.viewport, isMobile: viewport.mobile, hasTouch: viewport.mobile,
    deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' })
  const isolation = await isolateBrowser(context, server.base, scenario)
  // The browser is read-only, even if a future UI regression accidentally dispatches a write.
  await context.route('**/*', async route => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      scenario.unexpectedWrites.push(route.request().method() + ' ' + requestLabel(route.request().url()))
      await route.abort('blockedbyclient')
    } else await route.fallback()
  })
  await context.addCookies([ownerCookie])
  const page = await context.newPage(), holds = []
  page.setDefaultTimeout(15000)
  page.on('console', message => { if (message.type() === 'error') scenario.consoleErrors.push(redact(message.text(), secrets)) })
  page.on('pageerror', error => scenario.pageErrors.push(redact(error.stack || error, secrets)))
  const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'Books must not overflow the viewport horizontally')
  const booksReady = () => page.locator('#books-page').waitFor()
  try {
    await check(scenario, 'Paused, fully credited and overpaid invoices remain visible without netting receivables', async () => {
      await page.goto(server.base + '/#/books', { waitUntil: 'domcontentloaded' })
      await booksReady()
      const section = page.locator('section[aria-labelledby="collection-review-title"]')
      const text = await section.innerText()
      assert.match(text, /\$60\.10.*receivables.*review/)
      assert.match(text, /\$0\.10.*no saved review flag/)
      assert.match(text, /Review before collecting · 3 invoices/)
      assert.match(text, /2 flagged invoices have no positive balance/)
      assert.match(text, /No balance due/)
      assert.match(text, /Credit balance \$25\.25/)
      assert.match(text, /Active credits \$100\.00/)
      assert.match(text, /Active credits \$21\.50/)
      assert.equal(await section.getByRole('link').count(), 3)
      assert.match(await page.locator('.kpi').filter({ hasText: 'Total receivable' }).innerText(), /\$60\.20/)
      assert(!await page.locator('#books-page').innerText().then(t => /AR-BROWSER-(?:VOID|SETTLED)/.test(t)))
      await noOverflow()
      await screenshot(page, scenario, 'collection-review')
    })
    await check(scenario, 'Keyboard details toggle repeatedly and show credits separately from recorded payments', async () => {
      const review = page.locator('section[aria-labelledby="collection-review-title"] > details')
      await review.locator('summary').focus(); await page.keyboard.press('Enter')
      assert.equal(await review.evaluate(node => node.open), false)
      await page.keyboard.press('Enter')
      assert.equal(await review.evaluate(node => node.open), true)
      const customer = page.getByText('Synthetic receivables shop · 2 invoices · $60.20', { exact: true })
      await customer.click()
      const details = customer.locator('..')
      assert.match(await details.innerText(), /Net invoice \$80\.15 · Recorded payments \$20\.05 · Active credits \$21\.50/)
      assert.match(await details.innerText(), /No due date saved; aging uses invoice date/)
      await noOverflow()
      await screenshot(page, scenario, 'invoice-details')
      await customer.click(); await customer.click()
      assert.equal(await details.evaluate(node => node.open), true)
    })
    await check(scenario, 'Invoice links open the saved record and browser Back returns to current Books data', async () => {
      await page.locator('section[aria-labelledby="collection-review-title"]').getByRole('link', { name: 'AR-BROWSER-OPEN', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('#page-title')?.textContent === 'AR-BROWSER-OPEN')
      await page.goBack(); await booksReady()
      assert.match(await page.locator('#books-page').innerText(), /Review before collecting · 3 invoices/)
    })
    await check(scenario, 'A delayed Books response cannot overwrite Dashboard after Back; Forward loads a fresh report', async () => {
      await page.evaluate(() => { location.hash = '#/dashboard' })
      await page.locator('.rollup').waitFor()
      const held = await holdNextReport(page, scenario); holds.push(held)
      await page.evaluate(() => { location.hash = '#/books' })
      await held.ready()
      await page.goBack(); await page.locator('.rollup').waitFor()
      await held.close()
      await isolation.waitForIdle()
      assert.equal(await page.locator('#page-title').innerText(), 'Dashboard')
      assert.equal(await page.locator('#books-page').count(), 0)
      await page.goForward(); await booksReady()
      await noOverflow()
      await screenshot(page, scenario, 'returned-after-navigation')
    })
    await check(scenario, 'A different authenticated tenant sees its own empty report and no prior invoice evidence', async () => {
      await context.clearCookies(); await context.addCookies([neighborCookie])
      await page.goto(server.base + '/#/books', { waitUntil: 'domcontentloaded' }); await booksReady()
      const text = await page.locator('#books-page').innerText()
      assert.match(text, /No positive balances/)
      assert.match(text, /No invoices currently have a saved payment-review flag/)
      assert(!text.includes('AR-BROWSER-'))
      assert(!text.includes('Synthetic receivables shop'))
      assert.match(await page.locator('.kpi').filter({ hasText: 'Total receivable' }).innerText(), /\$0\.00/)
      await noOverflow()
      await screenshot(page, scenario, 'other-tenant')
    })
    await isolation.waitForIdle()
  } finally {
    try { for (const held of holds) await held.close() }
    finally { await isolation.close() }
  }
  await check(scenario, 'No browser writes, provider traffic, console errors or teardown errors occurred', async () => {
    for (const key of ['unexpectedWrites', 'blockedRequests', 'networkErrors', 'consoleErrors', 'pageErrors']) assert.deepEqual(scenario[key], [], key)
    assert(scenario.mockedWebSockets.length > 0, 'The stubbed realtime connection must be disclosed')
  })
}

try {
  mkdirSync(artifacts, { recursive: true })
  temp = mkdtempSync(join(tmpdir(), 'psc-ar-browser-'))
  const destination = join(temp, 'demo')
  server = await createHttpTestServer()
  const built = spawnSync(process.execPath, ['bin/demo.mjs', destination, String(server.port)], { cwd: root, encoding: 'utf8', timeout: 120000 })
  assert.equal(built.status, 0, 'Disposable demo preparation failed')
  const env = JSON.parse(readFileSync(join(destination, 'demo-env.json'), 'utf8'))
  const password = readFileSync(join(destination, 'LOGIN.txt'), 'utf8').match(/^Password: (.+)$/m)?.[1]
  assert(password); secrets.push(password, env.PSC_SECRET)
  assert.equal(env.PSC_DEMO, '1'); assert.equal(env.PSC_HOST, '127.0.0.1')
  const tenants = readdirSync(join(destination, 'data/tenants'))
  assert.equal(tenants.length, 1)
  db = new DatabaseSync(join(destination, 'data/tenants', tenants[0], 'printshop.db'))
  const fixture = seedReceivablesReview(db)
  await server.start({ cwd: destination, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
  const post = (path, body) => fetch(server.base + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  const cookieFrom = response => {
    assert.equal(response.status, 200, 'Synthetic authentication failed')
    const session = response.headers.getSetCookie().find(c => c.startsWith('psc_session='))?.split(';')[0].slice('psc_session='.length)
    assert(session); secrets.push(session)
    return { name: 'psc_session', value: session, url: server.base, httpOnly: true, sameSite: 'Lax' }
  }
  const ownerCookie = cookieFrom(await post('/api/auth/login', { email: 'dylan@example.test', password }))
  const neighborCookie = cookieFrom(await post('/api/auth/signup', { shop_name: 'Empty receivables neighbor', owner_name: 'Synthetic neighbor', owner_email: 'ar-browser-neighbor@example.test', password }))
  const privateRead = await fetch(server.base + '/api/invoices/' + fixture.ids['AR-BROWSER-OPEN'], { headers: { Cookie: 'psc_session=' + neighborCookie.value }, signal: AbortSignal.timeout(15000) })
  assert.equal(privateRead.status, 404, 'The neighboring tenant must not read the fixture invoice')
  const before = receivablesSnapshot(db)
  report.fixture = { invoiceCount: 6, expectedReceivable: 60.20, expectedReviewDue: 60.10, expectedReviewCount: 3, expectedCreditBalance: 25.25, neighborPrivateRead: 404 }
  const version = JSON.parse(readFileSync(join(root, '.browser-tools/node_modules/playwright/package.json'), 'utf8')).version
  assert.equal(version, '1.64.0', 'Use the repository-pinned browser tooling')
  report.playwrightVersion = version
  const { chromium } = await import(pathToFileURL(tool).href)
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true })
  report.browserVersion = browser.version()
  const failures = []
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }]) {
    try { await exercise(viewport, ownerCookie, neighborCookie) }
    catch (error) { failures.push(error); console.error(redact(error.stack || error, secrets)) }
  }
  assert.deepEqual(receivablesSnapshot(db), before, 'Browser review must not mutate invoices, credits or recorded payments')
  report.financialSnapshotUnchanged = true
  assert.equal(failures.length, 0, 'Browser scenarios failed; inspect receivables-review-report.json')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = redact(error.stack || error, secrets)
  console.error(report.error); process.exitCode = 1
} finally {
  try {
    await browser?.close(); await server?.close(); db?.close()
    if (temp) rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (error) {
    report.status = 'failed'; report.cleanupError = redact(error.stack || error, secrets); process.exitCode = 1
  } finally { writeFileSync(join(artifacts, 'receivables-review-report.json'), redact(JSON.stringify(report, null, 2), secrets) + '\n') }
}
