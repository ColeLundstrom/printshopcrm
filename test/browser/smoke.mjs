#!/usr/bin/env node
/** Real Google Chrome UI checks against a disposable demo. Never accepts a production URL. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from '../helpers/http-test-server.mjs'
import { isolateBrowser, redact, requestLabel } from './isolation.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const artifacts = join(root, 'browser-artifacts')
const tools = resolve(root, '.browser-tools/node_modules/playwright/index.mjs')
const quote = { quantity: 100, garment_cost: 4, consumable_cost: 1, spoilage_pct: 5,
  setup_minutes: 30, output_hour: 100, machine_rate: 20, labor_rate: 30,
  overhead_rate: 10, other_cost: 5, payment_pct: 3, payment_flat: 0.3, target_margin_pct: 40 }
const monthly = { fixed_cost_month: 6000, variable_cost_pct: 40, target_profit_month: 3000,
  forecast_revenue: 20000, productive_hours_month: 120 }
const report = { browser: 'Google Chrome (sandbox enabled)', browserChannel: 'chrome', data: 'Disposable synthetic demo',
  realtimeCoverage: 'The exact local /ws endpoint is explicitly stubbed. Real WebSocket connectivity and delivery are not tested.', scenarios: [] }
const secrets = []
let server, browser, temp

async function check(scenario, name, action) {
  try { await action(); scenario.checks.push({ name, status: 'passed' }); console.log('  PASS ' + name) }
  catch (error) { scenario.checks.push({ name, status: 'failed', error: redact(error.stack || error, secrets) }); throw error }
}

async function screenshot(page, scenario, name) {
  // No auth pages or traces are captured. Even an unexpected password field is masked.
  assert.equal(new URL(page.url()).pathname, '/', 'Screenshots are limited to the signed-in app')
  const filename = scenario.name + '-' + name + '.png'
  // Start at the top so fixed navigation and sticky headers appear once, at the top
  // of the composite, instead of obscuring whichever field the last action scrolled to.
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: join(artifacts, filename), fullPage: true,
    animations: 'disabled', mask: [page.locator('input[type="password"]')] })
  scenario.screenshots.push(filename)
}

async function fill(page, prefix, values) {
  for (const [key, value] of Object.entries(values)) await page.locator('#' + prefix + key).fill(String(value))
}

async function metric(page, parent, label, expected) {
  const value = page.locator(parent + ' .kpi').filter({ has: page.getByText(label, { exact: true }) }).locator('.val')
  assert.equal(await value.innerText(), expected, label)
}

async function emptyQuote(page, message, role = 'status') {
  assert.match(await page.locator('#profit-quote-results').getByRole(role).innerText(), message)
  assert.equal(await page.locator('#profit-quote-results .kpi').count(), 0)
  assert.equal(await page.locator('#profit-breaks table').count(), 0)
  assert(await page.getByRole('button', { name: 'Export quantity sheet', exact: true }).isDisabled())
}

async function readExport(page, scenario, filename) {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export quantity sheet', exact: true }).click()
  const download = await pending
  assert.equal(download.suggestedFilename(), 'printshopcrm-modeled-price-breaks.csv')
  assert.equal(await download.failure(), null)
  const path = join(artifacts, scenario.name + '-' + filename + '.csv')
  await download.saveAs(path)
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/)
  assert.equal(lines.shift(), 'Quantity,Minimum modeled unit price,Sales before tax,Modeled cost before processing,Processing fee,Modeled profit,Modeled margin percent')
  return lines.map(line => line.split(',').map(Number))
}

async function exercise(viewport, cookies) {
  const scenario = { name: viewport.name, checks: [], screenshots: [], consoleErrors: [], pageErrors: [], blockedRequests: [], networkErrors: [], unexpectedWrites: [], mockedWebSockets: [] }
  report.scenarios.push(scenario)
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.mobile, hasTouch: viewport.mobile, deviceScaleFactor: 1, locale: 'en-US',
    colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true })
  const isolation = await isolateBrowser(context, server.base, scenario)
  await context.addCookies(cookies)
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('console', message => { if (message.type() === 'error') scenario.consoleErrors.push(redact(message.text(), secrets)) })
  page.on('pageerror', error => scenario.pageErrors.push(redact(error.stack || error, secrets)))
  page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) scenario.unexpectedWrites.push(request.method() + ' ' + requestLabel(request.url())) })
  try {
    await check(scenario, 'Planner opens with empty assumptions and a disabled export', async () => {
      await page.goto(server.base + '/#/profit-planner', { waitUntil: 'domcontentloaded' })
      await page.locator('#profit-page').waitFor()
      assert.equal(await page.locator('#page-title').innerText(), 'Profit planner')
      await emptyQuote(page, /Enter your costs/)
      await screenshot(page, scenario, 'initial')
    })
    await check(scenario, 'Inputs have accessible labels and results announce updates', async () => {
      assert.equal(await page.locator('html').getAttribute('lang'), 'en')
      const missing = await page.locator('#profit-page input, #profit-page select').evaluateAll(fields => fields
        .filter(field => !field.labels?.length || ![...field.labels].some(label => label.textContent.trim()))
        .map(field => field.id))
      assert.deepEqual(missing, [], 'Every planner field needs a nonempty associated label')
      assert.equal(await page.getByLabel('Finished pieces', { exact: true }).getAttribute('type'), 'number')
      assert.equal(await page.locator('#profit-quote-results').getAttribute('aria-live'), 'polite')
      assert.equal(await page.locator('#profit-month-results').getAttribute('aria-live'), 'polite')
      const example = page.getByRole('button', { name: 'Try example costs', exact: true })
      await example.focus(); await page.keyboard.press('Enter')
      assert.equal(await page.getByLabel('Finished pieces', { exact: true }).inputValue(), '144')
      assert.match(await page.locator('#profit-input-basis').innerText(), /Example costs loaded/)
    })
    await check(scenario, 'Known costs produce the expected quantity prices and monthly targets', async () => {
      await fill(page, 'profit-', quote)
      await fill(page, 'profit-month-', monthly)
      await metric(page, '#profit-quote-results', 'Minimum modeled price / piece', '$10.89')
      await metric(page, '#profit-quote-results', 'Sales before tax', '$1,089.00')
      await metric(page, '#profit-quote-results', 'Modeled profit after fees', '$436.03')
      await metric(page, '#profit-quote-results', 'Modeled profit margin', '40.04%')
      await metric(page, '#profit-month-results', 'Break-even sales / month', '$10,000.00')
      await metric(page, '#profit-month-results', 'Sales for your profit goal', '$15,000.00')
      await metric(page, '#profit-month-results', 'Forecast modeled profit', '$6,000.00')
      await metric(page, '#profit-month-results', 'Target sales / productive hour', '$125.00')
      const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }))
      assert(dimensions.content <= dimensions.viewport + 1, 'The planner must not cause horizontal page overflow')
      await screenshot(page, scenario, 'valid-planner')
      const rows = await readExport(page, scenario, 'quantity-100')
      assert.equal(rows.length, 8)
      assert.deepEqual(rows.find(row => row[0] === 100).slice(0, 6), [100, 10.89, 1089, 620, 32.97, 436.03])
    })
    await check(scenario, 'Repeated edits refresh the CSV instead of exporting the old quantity', async () => {
      await page.getByLabel('Finished pieces', { exact: true }).fill('240')
      const rows = await readExport(page, scenario, 'quantity-240')
      assert(rows.some(row => row[0] === 240)); assert(!rows.some(row => row[0] === 100))
      assert.equal(await page.locator('#profit-breaks tbody tr').filter({ has: page.getByRole('cell', { name: '240', exact: true }) }).count(), 1)
      await screenshot(page, scenario, 'repeated-edit')
    })
    await check(scenario, 'Invalid and then empty input clear both results and downloadable CSV state', async () => {
      await page.getByLabel('Finished pieces', { exact: true }).fill('0')
      await emptyQuote(page, /quantity must be a positive safe integer/, 'alert')
      await screenshot(page, scenario, 'invalid-quantity')
      await page.getByLabel('Finished pieces', { exact: true }).fill('100')
      await metric(page, '#profit-quote-results', 'Minimum modeled price / piece', '$10.89')
      await page.getByLabel('Blank cost / piece', { exact: true }).fill('')
      await emptyQuote(page, /Enter your costs/)
      await screenshot(page, scenario, 'cleared-after-edit')
      await page.getByLabel('Blank cost / piece', { exact: true }).fill('4')
      await page.getByLabel('Finished pieces', { exact: true }).fill('1.5')
      await emptyQuote(page, /quantity must be a positive safe integer/, 'alert')
      await page.getByLabel('Finished pieces', { exact: true }).fill('100')
    })
    await check(scenario, 'Monthly losses, impossible margins and cleared inputs never keep stale goals', async () => {
      await fill(page, 'profit-month-', { fixed_cost_month: 10000, variable_cost_pct: 50, target_profit_month: 5000, forecast_revenue: 1000, productive_hours_month: 100 })
      await metric(page, '#profit-month-results', 'Forecast modeled profit', '-$9,500.00')
      await metric(page, '#profit-month-results', 'Sales for your profit goal', '$30,000.00')
      await screenshot(page, scenario, 'monthly-loss')
      await page.getByLabel('Variable costs as % of sales', { exact: true }).fill('100')
      assert.match(await page.locator('#profit-month-results').getByRole('alert').innerText(), /less than 100/)
      assert.equal(await page.locator('#profit-month-results .kpi').count(), 0)
      await screenshot(page, scenario, 'invalid-monthly')
      await page.getByLabel('Variable costs as % of sales', { exact: true }).fill('')
      assert.match(await page.locator('#profit-month-results').getByRole('status').innerText(), /Enter all five/)
      assert.equal(await page.locator('#profit-month-results .kpi').count(), 0)
    })
    await check(scenario, 'Navigation and browser Back/Forward reopen a fresh, unsaved planner', async () => {
      await page.locator('#page-actions').getByRole('link', { name: 'Job cost comparison', exact: true }).click()
      await page.getByRole('heading', { name: 'Production cost comparison', exact: true }).waitFor()
      assert.equal(await page.locator('#profit-page').count(), 0)
      await page.goBack()
      await page.locator('#profit-page').waitFor()
      await emptyQuote(page, /Enter your costs/)
      assert.equal(await page.getByLabel('Finished pieces', { exact: true }).inputValue(), '144')
      assert.equal(await page.getByLabel('Blank cost / piece', { exact: true }).inputValue(), '')
      await page.goForward()
      await page.getByRole('heading', { name: 'Production cost comparison', exact: true }).waitFor()
      await page.goBack(); await page.locator('#profit-page').waitFor()
      await emptyQuote(page, /Enter your costs/)
      if (viewport.mobile) {
        const menu = page.getByRole('button', { name: 'Menu', exact: true })
        await menu.click()
        assert.equal(await menu.getAttribute('aria-expanded'), 'true')
        await page.keyboard.press('Escape')
        assert.equal(await menu.getAttribute('aria-expanded'), 'false')
        assert(await menu.evaluate(element => document.activeElement === element), 'Escape returns keyboard focus to the menu')
      }
      await isolation.waitForIdle()
      await screenshot(page, scenario, 'returned-fresh')
    })
  } catch (error) {
    if (new URL(page.url()).pathname === '/') await screenshot(page, scenario, 'failure').catch(() => {})
    throw error
  } finally {
    await isolation.close()
  }
  // Assert only after every route callback has settled, including teardown failures.
  await check(scenario, 'The planner makes no writes, external requests or browser errors', async () => {
    assert.deepEqual(scenario.unexpectedWrites, [])
    assert.deepEqual(scenario.blockedRequests, [])
    assert.deepEqual(scenario.networkErrors, [])
    assert.deepEqual(scenario.pageErrors, [])
    assert.deepEqual(scenario.consoleErrors, [])
    assert(scenario.mockedWebSockets.length > 0, 'The explicitly stubbed realtime connection should be recorded')
  })
}

try {
  mkdirSync(artifacts, { recursive: true })
  const { chromium } = await import(pathToFileURL(tools).href)
  temp = mkdtempSync(join(tmpdir(), 'psc-browser-demo-'))
  const destination = join(temp, 'instance')
  server = await createHttpTestServer()
  const prepared = spawnSync(process.execPath, ['bin/demo.mjs', destination, String(server.port)], { cwd: root, encoding: 'utf8', timeout: 120000 })
  assert.equal(prepared.status, 0, 'Isolated synthetic demo preparation failed')
  const env = JSON.parse(readFileSync(join(destination, 'demo-env.json'), 'utf8'))
  const password = readFileSync(join(destination, 'LOGIN.txt'), 'utf8').match(/^Password: (.+)$/m)?.[1]
  assert(password, 'Demo credentials were not generated')
  secrets.push(password, env.PSC_SECRET)
  assert.equal(env.PSC_HOST, '127.0.0.1')
  assert.equal(env.PSC_DEMO, '1')
  await server.start({ cwd: destination, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
  const login = await fetch(server.base + '/api/auth/login', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password }) })
  assert.equal(login.status, 200, 'Synthetic demo sign-in failed')
  const session = login.headers.getSetCookie().find(cookie => cookie.startsWith('psc_session='))?.split(';')[0].slice('psc_session='.length)
  assert(session, 'Synthetic demo session missing')
  secrets.push(session)
  const cookies = [{ name: 'psc_session', value: session, url: server.base, httpOnly: true, sameSite: 'Lax' }]
  // Official Chrome uses the host's existing supported sandbox/AppArmor configuration.
  // Do not weaken the sandbox when a runner cannot start it. That is a CI blocker.
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true })
  report.browserVersion = browser.version()
  const failures = []
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }]) {
    console.log('Browser smoke: ' + viewport.name)
    try { await exercise(viewport, cookies) } catch (error) { failures.push(error); console.error(redact(error.stack || error, secrets)) }
  }
  assert.equal(failures.length, 0, 'One or more browser scenarios failed; inspect browser-artifacts/report.json and screenshots')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = redact(error.stack || error, secrets)
  console.error(report.error)
  process.exitCode = 1
} finally {
  try {
    await browser?.close()
    await server?.close()
    if (temp) rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (error) {
    report.status = 'failed'
    report.cleanupError = redact(error.stack || error, secrets)
    process.exitCode = 1
  } finally {
    writeFileSync(join(artifacts, 'report.json'), redact(JSON.stringify(report, null, 2), secrets) + '\n')
  }
}
