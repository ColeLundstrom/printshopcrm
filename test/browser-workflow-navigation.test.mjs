import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { leaveQuoteForEstimateList, switchReadOnlyTenant } from './browser/workflow-navigation.mjs'

test('quote smoke uses the visible mobile menu and preserves the desktop breadcrumb', async () => {
  for (const mobile of [false, true]) {
    const calls = []
    const page = {
      getByRole: (role, options) => ({ click: async () => calls.push([role, options]) }),
      locator: selector => ({ click: async () => calls.push(selector), getByRole: (role, options) => ({ click: async () => calls.push([selector, role, options]) }) }),
    }
    await leaveQuoteForEstimateList(page, mobile)
    assert.deepEqual(calls, mobile ? [['button', { name: 'Menu', exact: true }], ['#nav', 'link', { name: 'Estimates', exact: true }]] : ['#crumb a[href="#/estimates"]'])
  }
})

test('switching synthetic tenant cookies reloads the document and verifies the new shop before reading', async () => {
  const calls = [], cookie = { name: 'psc_session', value: 'synthetic-session', url: 'http://127.0.0.1:4380' }
  const page = { url: () => cookie.url + '/#/books', reload: async options => calls.push(['reload', options]), waitForFunction: async (predicate, expected) => { assert.match(String(predicate), /window\.__me/); calls.push(['identity', expected]) } }
  const context = { clearCookies: async () => calls.push('clear'), addCookies: async cookies => calls.push(['cookies', cookies]) }
  await switchReadOnlyTenant(page, context, cookie, 'synthetic-neighbor')
  assert.deepEqual(calls, ['clear', ['cookies', [cookie]], ['reload', { waitUntil: 'domcontentloaded' }], ['identity', 'synthetic-neighbor']])
  await assert.rejects(switchReadOnlyTenant({ ...page, url: () => 'https://example.test/#/books' }, context, cookie, 'synthetic-neighbor'), /synthetic app origin/)
  assert.equal(calls.length, 4, 'No cookies change for an unapproved origin')
})

test('browser workflow scenarios use verified navigation helpers and mask signed sample links', () => {
  const quote = readFileSync(new URL('./browser/estimate-duplicate-smoke.mjs', import.meta.url), 'utf8')
  const books = readFileSync(new URL('./browser/receivables-review-smoke.mjs', import.meta.url), 'utf8')
  assert.match(quote, /await leaveQuoteForEstimateList\(page,viewport\.mobile\)/)
  assert.match(quote, /mask:\[page\.locator\('input\[type="password"\]'\),page\.locator\('#share'\)\]/)
  assert.match(books, /await switchReadOnlyTenant\(page, context, neighborCookie, neighborSlug\)/)
})
