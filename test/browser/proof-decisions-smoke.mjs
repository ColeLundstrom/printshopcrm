#!/usr/bin/env node
/** Public proof forms, with synthetic data and only explicitly registered local redirects. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from '../helpers/http-test-server.mjs'
import { isolateBrowser, requestLabel, redact } from './isolation.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const artifacts = join(root, 'browser-artifacts')
const report = { scope: 'Public proof decisions', browser: 'Official Google Chrome; sandbox enabled', data: 'Disposable synthetic demo', status: 'starting', screenshots: [], viewports: [], consoleErrors: [], pageErrors: [], blockedRequests: [], networkErrors: [], mockedWebSockets: [], validatedProofRedirects: 0, expectedValidationResponses: 0 }
const secrets = [], pending = new Set()
const clean = value => redact(value, secrets).replace(/([?&](?:k|t)=)[^&#\s"'<>]+/g, '$1[redacted]')
let browser, server, temp, isolation, closing = false, browserStarting = true
try {
  mkdirSync(artifacts, { recursive: true })
  const { chromium } = await import(pathToFileURL(join(root, '.browser-tools/node_modules/playwright/index.mjs')).href)
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true })
  report.browserVersion = browser.version()
  browserStarting = false
  temp = mkdtempSync(join(tmpdir(), 'psc-proof-browser-'))
  const destination = join(temp, 'demo')
  server = await createHttpTestServer()
  const built = spawnSync(process.execPath, ['bin/demo.mjs', destination, String(server.port)], { cwd: root, encoding: 'utf8', timeout: 90000 })
  assert.equal(built.status, 0, built.stderr)
  const env = JSON.parse(readFileSync(join(destination, 'demo-env.json'), 'utf8'))
  assert.equal(env.PSC_DEMO, '1')
  await server.start({ cwd: destination, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
  const password = readFileSync(join(destination, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1]
  secrets.push(password, env.PSC_SECRET)
  const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  secrets.push(cookie, ...cookie.split('; ').map(value => value.slice(value.indexOf('=') + 1)))
  const staff = async (path, body) => {
    const response = await fetch(server.base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.status, 200, 'Synthetic staff fixture request: ' + path)
    return response.json()
  }
  const customer = await staff('/api/contacts', { name: 'Proof browser fixture', email: 'proof-browser@example.test' })
  const upload = async job => {
    const form = new FormData()
    form.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="navy"/><text x="60" y="130" fill="white" font-size="32">SYNTHETIC PROOF</text></svg>'], { type: 'image/svg+xml' }), 'synthetic-proof.svg')
    const response = await fetch(server.base + '/api/jobs/' + job.id + '/art', { method: 'POST', headers: { Cookie: cookie }, body: form })
    assert.equal(response.status, 200)
    const saved = await response.json()
    const art = (await staff('/api/jobs/' + job.id)).art.find(row => row.id === saved.id)
    secrets.push(new URL(art.share_url, server.base).searchParams.get('k'))
    return art
  }
  const snapshot = async job => {
    const state = await staff('/api/jobs/' + job.id)
    return { stage: state.stage, status: state.status, due_date: state.due_date, art_approved_at: state.art_approved_at, art_revision: state.art_revision,
      art: state.art.map(({ id, status, notes, decided_at, decided_by }) => ({ id, status, notes, decided_at, decided_by })),
      activities: state.activities }
  }
  for (const [name, viewport] of [['desktop', { width: 1365, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile', deviceScaleFactor: 1, serviceWorkers: 'block', reducedMotion: 'reduce' })
    closing = false
    isolation = await isolateBrowser(context, server.base, report)
    // Anonymous customer context: staff cookies are never installed in this browser.
    const page = await context.newPage()
    const expected400 = new Set()
    page.on('console', message => {
      if (message.type() !== 'error') return
      if (expected400.has(message.location().url) && /\b400\b/.test(message.text())) return
      report.consoleErrors.push(clean(message.text()))
    })
    page.on('pageerror', error => report.pageErrors.push(clean(error.message)))
    const capture = async label => {
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ': horizontal overflow')
      const filename = `proof-decisions-${name}-${label}.png`
      await page.screenshot({ path: join(artifacts, filename), animations: 'disabled', fullPage: true })
      report.screenshots.push(filename)
    }
    const register = async art => {
      const canonical = server.base + art.share_url
      const postUrl = canonical.replace('?', '/decide?')
      // The shared guard deliberately refuses all redirects. This exception is exact: one
      // registered synthetic POST may return only to its own registered signed proof GET.
      await context.route(postUrl, route => {
        const task = (async () => {
          try {
            if (closing || route.request().method() !== 'POST') return await route.abort('blockedbyclient')
            const response = await route.fetch({ maxRedirects: 0, timeout: 15000 })
            if (response.status() >= 300 && response.status() < 400) {
              assert.equal(response.status(), 302)
              assert.equal(new URL(response.headers().location, server.base).href, canonical, 'Proof form redirected outside its registered return page')
              report.validatedProofRedirects++
            }
            await route.fulfill({ response })
          } catch (error) {
            if (!closing) report.networkErrors.push(requestLabel(postUrl) + ': ' + clean(error.message))
            try { await route.abort('failed') } catch { /* Context teardown can already own the route. */ }
          }
        })()
        pending.add(task)
        void task.then(() => pending.delete(task))
        return task
      })
      return { canonical, postUrl }
    }
    const job = await staff('/api/jobs', { contact_id: customer.id, title: 'Synthetic ' + name + ' proof review', approval_gated: true })
    const first = await upload(job), firstLink = await register(first)
    await page.goto(firstLink.canonical)
    await page.locator('.proof img').evaluate(image => image.decode())
    assert.equal(await page.getByRole('button', { name: 'Approve proof', exact: true }).count(), 1)
    await capture('current')
    const before = await snapshot(job)
    await page.locator('textarea[name="notes"]').fill('Move the logo left')
    await page.locator('form').evaluate(form => { const alias = document.createElement('input'); alias.type = 'hidden'; alias.name = 'approved'; alias.value = '1'; form.append(alias) })
    expected400.add(firstLink.postUrl)
    const [invalid] = await Promise.all([
      page.waitForResponse(response => response.url() === firstLink.postUrl && response.request().isNavigationRequest()),
      page.getByRole('button', { name: 'Request changes', exact: true }).click(),
    ])
    assert.equal(invalid.status(), 400)
    report.expectedValidationResponses++
    await page.getByText('Conflicting decisions.', { exact: false }).waitFor()
    assert.deepEqual(await snapshot(job), before, 'Conflicting form did not sign off or release production')
    await capture('invalid-choice')
    // Reloading the public proof restores its ordinary form after an invalid submission.
    await page.goto(firstLink.canonical)
    await page.locator('textarea[name="notes"]').fill('Move the logo left')
    const [requested] = await Promise.all([
      page.waitForResponse(response => response.url() === firstLink.postUrl && response.request().isNavigationRequest()),
      page.getByRole('button', { name: 'Request changes', exact: true }).click(),
    ])
    assert.equal(requested.status(), 302)
    await page.waitForURL(firstLink.canonical)
    await page.getByText('Changes requested.', { exact: false }).waitFor()
    assert.equal((await snapshot(job)).art.find(row => row.id === first.id).status, 'rejected')
    await capture('changes-requested')
    const current = await upload(job), currentLink = await register(current)
    await page.goto(firstLink.canonical)
    await page.getByText('This proof has been replaced by a newer version.', { exact: false }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Approve proof', exact: true }).count(), 0)
    await page.goto(currentLink.canonical)
    const [accepted] = await Promise.all([
      page.waitForResponse(response => response.url() === currentLink.postUrl && response.request().isNavigationRequest()),
      page.getByRole('button', { name: 'Approve proof', exact: true }).click(),
    ])
    assert.equal(accepted.status(), 302)
    await page.waitForURL(currentLink.canonical)
    await page.getByText('Approved — thank you!', { exact: false }).waitFor()
    const approved = await snapshot(job)
    assert.equal(approved.art.find(row => row.id === current.id).status, 'approved')
    assert.ok(approved.art_approved_at)
    assert.equal(await page.getByRole('button', { name: 'Approve proof', exact: true }).count(), 0)
    await capture('approved')
    const replay = await fetch(currentLink.postUrl, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'decision=rejected&notes=Late+repeat' })
    assert.equal(replay.status, 302)
    assert.deepEqual(await snapshot(job), approved, 'A stale repeated decision does not rewrite the accepted proof')
    await page.reload()
    await page.getByText('Approved — thank you!', { exact: false }).waitFor()
    await Promise.all([...pending])
    await isolation.waitForIdle()
    closing = true
    await isolation.close()
    isolation = null
    await Promise.all([...pending])
    report.viewports.push({ name, ...viewport, status: 'passed' })
  }
  assert.deepEqual(report.consoleErrors, [])
  assert.deepEqual(report.pageErrors, [])
  assert.deepEqual(report.blockedRequests, [])
  assert.deepEqual(report.networkErrors, [])
  assert.equal(report.expectedValidationResponses, 2)
  assert.equal(report.validatedProofRedirects, 4)
  report.status = 'passed'
  console.log('Public proof decisions browser smoke passed on desktop and mobile.')
} catch (error) {
  report.status = browserStarting ? 'blocked' : 'failed'
  report.error = clean(error.stack || String(error))
  console.error(report.error)
  process.exitCode = 1
} finally {
  closing = true
  await isolation?.close().catch(error => report.networkErrors.push(clean(error.message)))
  await Promise.all([...pending])
  await browser?.close().catch(() => {})
  await server?.close().catch(() => {})
  if (temp) rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  if (report.status === 'passed' && [report.consoleErrors, report.pageErrors, report.blockedRequests, report.networkErrors].some(errors => errors.length)) {
    report.status = 'failed'
    report.error = 'Browser teardown recorded unexpected errors; inspect the redacted report.'
    process.exitCode = 1
  }
  writeFileSync(join(artifacts, 'proof-decisions-report.json'), clean(JSON.stringify(report, null, 2)) + '\n')
}
