#!/usr/bin/env node
/** Read-only purchasing UI checks against a disposable authenticated demo, never a live shop. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHttpTestServer } from '../helpers/http-test-server.mjs'
import { seedPurchasingFixture } from '../helpers/purchasing-fixture.mjs'
import { isolateBrowser, redact, requestLabel } from './isolation.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const artifacts = join(root, 'browser-artifacts')
const tool = join(root, '.browser-tools/node_modules/playwright/index.mjs')
const report = { data: 'Disposable synthetic demo', sandbox: true, realtimeCoverage: 'The exact local /ws endpoint is stubbed. Real WebSocket delivery is not tested.', scenarios: [] }
const secrets = []
let server, browser, temp, db
try {
  mkdirSync(artifacts, { recursive: true })
  const { chromium } = await import(pathToFileURL(tool).href)
  temp = mkdtempSync(join(tmpdir(), 'psc-purchasing-browser-'))
  const destination = join(temp, 'demo')
  server = await createHttpTestServer()
  const built = spawnSync(process.execPath, ['bin/demo.mjs', destination, String(server.port)], { cwd: root, encoding: 'utf8', timeout: 90000 })
  assert.equal(built.status, 0, built.stderr)
  const env = JSON.parse(readFileSync(join(destination, 'demo-env.json'), 'utf8')); env.PSC_TICK_MS = '3600000'
  assert.equal(env.PSC_DEMO, '1')
  const tenantRoot = join(destination, 'data/tenants')
  db = new DatabaseSync(join(tenantRoot, readdirSync(tenantRoot)[0], 'printshop.db'))
  const fixtures = seedPurchasingFixture(db)
  await server.start({ cwd: destination, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
  const password = readFileSync(join(destination, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1]
  secrets.push(password, env.PSC_SECRET)
  const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password }) })
  assert.equal(login.status, 200)
  const session = login.headers.getSetCookie().find(cookie => cookie.startsWith('psc_session='))?.split(';')[0].slice('psc_session='.length)
  assert(session); secrets.push(session)
  const snapshot = () => JSON.stringify(db.prepare('SELECT * FROM purchase_orders ORDER BY id').all()) + JSON.stringify(db.prepare('SELECT * FROM po_lines ORDER BY id').all())
  const before = snapshot()
  // The default is the repository's official Chrome channel. An explicit installed executable
  // can be supplied on cloud Linux; the sandbox stays enabled in either case.
  const executable = process.env.PSC_BROWSER_EXECUTABLE
  browser = await chromium.launch({ ...(executable ? { executablePath: executable } : { channel: 'chrome' }), headless: true, chromiumSandbox: true, env: { ...process.env, XDG_CONFIG_HOME: join(temp, 'browser-config') } })
  report.browserVersion = browser.version()
  report.browser = executable ? 'Explicit installed browser: ' + executable : 'Google Chrome'
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'tablet', width: 768, height: 1024 }, { name: 'mobile-414', width: 414, height: 896 }, { name: 'mobile-375', width: 375, height: 812 }, { name: 'mobile-320', width: 320, height: 740 }]) {
    const scenario = { ...viewport, screenshots: [], checks: [], consoleErrors: [], pageErrors: [], blockedRequests: [], networkErrors: [], mockedWebSockets: [], unexpectedWrites: [] }
    report.scenarios.push(scenario)
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.width < 768, hasTouch: viewport.width < 768, deviceScaleFactor: 1, serviceWorkers: 'block', reducedMotion: 'reduce' })
    const isolation = await isolateBrowser(context, server.base, scenario)
    try {
      await context.addCookies([{ name: 'psc_session', value: session, url: server.base, httpOnly: true, sameSite: 'Lax' }])
      const page = await context.newPage(); page.setDefaultTimeout(15000)
      page.on('console', message => { if (message.type() === 'error') scenario.consoleErrors.push(redact(message.text(), secrets)) })
      page.on('pageerror', error => scenario.pageErrors.push(redact(error.message, secrets)))
      page.on('request', request => { if (!['GET','HEAD','OPTIONS'].includes(request.method())) scenario.unexpectedWrites.push(request.method() + ' ' + requestLabel(request.url())) })
      const capture = async name => {
        assert.equal(new URL(page.url()).pathname, '/')
        const filename = 'purchasing-' + viewport.name + '-' + name + '.png'
        await page.evaluate(() => window.scrollTo(0,0))
        await page.screenshot({ path: join(artifacts, filename), fullPage: true, animations: 'disabled', mask: [page.locator('input[type="password"]')] })
        scenario.screenshots.push(filename)
      }
      const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal page overflow')
      const show = async () => {
        const previous = await page.locator('#purchasing-page').elementHandle()
        await page.getByRole('button', { name: 'Show purchase orders', exact: true }).click()
        await previous.waitForElementState('hidden')
        await page.locator('#purchasing-page').waitFor()
      }
      await page.goto(server.base + '/#/purchasing?q=PURCHASING&page_size=2')
      await page.locator('#purchasing-page').waitFor()
      assert.match(await page.locator('#purchasing-result-count').innerText(), /4 purchase orders/)
      assert.equal(await page.locator('.purchasing-card').count(), 2)
      assert.equal(await page.locator('.purchasing-card img').count(), 0, 'HTML-like job text remains text')
      assert.match(await page.locator('.purchasing-card').first().innerText(), /6 outstanding/)
      assert.match(await page.locator('.purchasing-card').first().innerText(), /overdue with outstanding/)
      const missing = await page.locator('#purchasing-filter input,#purchasing-filter select').evaluateAll(fields => fields.filter(field => !field.labels?.length).map(field => field.id))
      assert.deepEqual(missing, [])
      await noOverflow(); await capture('attention'); scenario.checks.push('Default attention view, correct totals, literal text and associated labels')
      await page.getByLabel('View', { exact: true }).selectOption('short_closed'); await show()
      assert.match(await page.locator('#purchasing-results').innerText(), /7 closed short/)
      assert.doesNotMatch(await page.locator('#purchasing-results').innerText(), /Fully received/)
      await noOverflow(); await capture('short-closed'); scenario.checks.push('Short close stays distinct from receipt')
      await page.getByLabel('View', { exact: true }).selectOption('all'); await show()
      await page.getByRole('navigation', { name: 'Purchase order pages' }).getByRole('link', { name: 'Next', exact: true }).click()
      await page.locator('[data-po="' + fixtures.short.id + '"]').waitFor()
      assert.match(await page.locator('#purchasing-result-count').innerText(), /6 purchase orders/)
      assert.match(await page.getByRole('navigation', { name: 'Purchase order pages' }).innerText(), /Page 2 of 3/)
      await page.goBack(); await page.locator('[data-po="' + fixtures.partial.id + '"]').waitFor()
      assert.equal(await page.getByLabel('View', { exact: true }).inputValue(), 'all')
      scenario.checks.push('Paging and Back preserve filters')
      await page.getByLabel('View', { exact: true }).selectOption('outstanding')
      await page.getByLabel('Supplier', { exact: true }).selectOption('Synthetic & Supply')
      await page.getByLabel('PO or job search').fill('PURCHASING-PARTIAL'); await show()
      assert.equal(await page.locator('.purchasing-card').count(), 1)
      await page.getByRole('link', { name: 'Open receiving for J-PURCHASING-PARTIAL', exact: true }).click()
      await page.locator('[data-receive-po="' + fixtures.partial.id + '"]').waitFor()
      assert(await page.getByText('Receiving & garment counts', { exact: true }).evaluate(el => el.parentElement.open))
      assert.equal(await page.locator('[data-receive-po="' + fixtures.partial.id + '"] input[type="number"]').first().inputValue(), '4')
      await page.goBack(); await page.locator('#purchasing-page').waitFor()
      assert.equal(await page.getByLabel('PO or job search').inputValue(), 'PURCHASING-PARTIAL')
      await noOverflow(); await capture('filtered'); scenario.checks.push('Supplier/search filters and existing receiving handoff')
      await page.getByLabel('PO or job search').fill('NO-MATCH-EXPECTED'); await show()
      assert.match(await page.locator('#purchasing-results').innerText(), /No purchase orders in this view/)
      await noOverflow(); scenario.checks.push('Empty state and all checked widths have no page overflow')
      await isolation.waitForIdle()
    } finally { await isolation.close() }
    // Closing drains in-flight routes and can record an unexpected teardown error.
    for (const name of ['consoleErrors','pageErrors','blockedRequests','networkErrors','unexpectedWrites']) assert.deepEqual(scenario[name], [], name)
  }
  assert.equal(snapshot(), before, 'Browser review never changes purchase orders or receiving counts')
  report.status = 'passed'; console.log('Purchasing browser smoke passed at five desktop/tablet/mobile widths.')
} catch (error) {
  report.status = 'failed'; report.error = redact(error.stack || error, secrets); console.error(report.error); process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await server?.close().catch(() => {})
  db?.close()
  if (temp) rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(artifacts, 'purchasing-report.json'), redact(JSON.stringify(report, null, 2), secrets) + '\n')
}
