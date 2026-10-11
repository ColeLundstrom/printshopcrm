#!/usr/bin/env node
/** Isolated phone review of saved customer terms through one invoice conversion. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from '../helpers/http-test-server.mjs'
import { isolateBrowser } from './isolation.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const artifacts = join(root, 'browser-artifacts')
const tool = join(root, '.browser-tools/node_modules/playwright/index.mjs')
const report = { viewport: '390 × 844', browser: 'Google Chrome, sandbox enabled', data: 'Synthetic demo', screenshots: [], consoleErrors: [], pageErrors: [], blockedRequests: [], networkErrors: [], mockedWebSockets: [] }
let server, browser, isolation, temp
try {
  mkdirSync(artifacts, { recursive: true })
  const { chromium } = await import(pathToFileURL(tool).href)
  temp = mkdtempSync(join(tmpdir(), 'psc-terms-browser-'))
  const destination = join(temp, 'demo')
  server = await createHttpTestServer()
  const built = spawnSync(process.execPath, ['bin/demo.mjs', destination, String(server.port)], { cwd: root, encoding: 'utf8', timeout: 90000 })
  assert.equal(built.status, 0, built.stderr)
  const env = JSON.parse(readFileSync(join(destination, 'demo-env.json'), 'utf8'))
  assert.equal(env.PSC_DEMO, '1')
  await server.start({ cwd: destination, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
  const password = readFileSync(join(destination, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1]
  const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password }) })
  assert.equal(login.status, 200)
  const session = login.headers.getSetCookie().find(cookie => cookie.startsWith('psc_session='))?.split(';')[0].slice('psc_session='.length)
  assert(session)
  const request = async (path, body) => {
    const response = await fetch(server.base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: `psc_session=${session}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
    return response.json()
  }
  const customer = await request('/api/contacts', { name: 'Mobile terms fixture', payment_term: 'net_30' })
  const estimate = await request('/api/estimates', { contact_id: customer.id, items: [{ description: 'Synthetic shirt', sizes: { M: 12 }, unit_price: 10 }], tax_rate: 0 })
  const detail = await request('/api/estimates/' + estimate.id)
  await request('/api/estimates/' + estimate.id + '/approve', { commercial_revision: detail.commercial_revision })

  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true })
  report.browserVersion = browser.version()
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, serviceWorkers: 'block', reducedMotion: 'reduce' })
  isolation = await isolateBrowser(context, server.base, report)
  await context.addCookies([{ name: 'psc_session', value: session, url: server.base, httpOnly: true, sameSite: 'Lax' }])
  const page = await context.newPage()
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()) })
  page.on('pageerror', error => report.pageErrors.push(error.message))
  const capture = async name => {
    const path = join(artifacts, `payment-terms-${name}.png`)
    await page.screenshot({ path, animations: 'disabled', mask: [page.locator('input[type="password"]')] })
    report.screenshots.push(path)
  }
  const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal page overflow')

  await page.goto(server.base + '/#/contacts/' + customer.id)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  assert.equal(await page.getByLabel('Default payment terms for new invoices').inputValue(), 'net_30')
  await noOverflow()
  await capture('mobile-customer')
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.goto(server.base + '/#/estimates/' + estimate.id)
  await page.getByRole('button', { name: 'Convert to Invoice + Job' }).click()
  assert.equal(await page.getByLabel('Payment terms', { exact: true }).inputValue(), 'net_30')
  assert.equal(await page.getByLabel('Override payment due date (optional)').inputValue(), '')
  await noOverflow()
  await capture('mobile-convert')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.goto(server.base + '/#/contacts/' + customer.id)
  await page.goBack()
  await page.getByRole('button', { name: 'Convert to Invoice + Job' }).click()
  assert.equal(await page.getByLabel('Payment terms', { exact: true }).inputValue(), 'net_30', 'Back navigation reloads the current term')
  await page.getByRole('button', { name: 'Create Invoice + Job' }).dblclick()
  await page.waitForURL(/#\/jobs\/\d+$/)
  const converted = await request('/api/estimates/' + estimate.id)
  assert(converted.invoice?.id)
  const invoice = await request('/api/invoices/' + converted.invoice.id)
  const due = new Date(Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z') + 30 * 864e5).toISOString().slice(0, 10)
  assert.equal(invoice.due_date, due)
  await page.goto(server.base + '/#/estimates/' + estimate.id)
  assert.equal(await page.getByRole('button', { name: 'Convert to Invoice + Job' }).count(), 0)
  await page.goto(server.base + '/#/invoices/' + invoice.id)
  await noOverflow()
  await capture('mobile-invoice')
  await isolation.waitForIdle()
  assert.deepEqual(report.consoleErrors, [])
  assert.deepEqual(report.pageErrors, [])
  assert.deepEqual(report.blockedRequests, [])
  assert.deepEqual(report.networkErrors, [])
  report.status = 'passed'
  console.log('Payment terms mobile browser smoke passed; screenshots: ' + report.screenshots.join(', '))
} catch (error) { report.status = 'failed'; report.error = error.stack || String(error); console.error(report.error); process.exitCode = 1 }
finally {
  await isolation?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await server?.close().catch(() => {})
  if (temp) rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
