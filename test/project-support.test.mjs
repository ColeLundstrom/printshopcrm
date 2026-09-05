import test from 'node:test'
import assert from 'node:assert/strict'
import { projectSupportConfig } from '../lib/project-support.mjs'

// Shape fixtures only: these are deliberately never fetched or presented as real checkouts.
const once = 'https://buy.stripe.com/fixtureOnce123'
const monthly = 'https://buy.stripe.com/fixtureMonthly456'
const manage = 'https://billing.stripe.com/p/login/fixtureManage789'
const github = 'https://github.com/sponsors/Fixture-Maintainer'
const fields = {
  PSC_PROJECT_SUPPORT_ONCE_URL: once, PSC_PROJECT_SUPPORT_MONTHLY_URL: monthly,
  PSC_PROJECT_SUPPORT_MANAGE_URL: manage, PSC_PROJECT_SUPPORT_GITHUB_URL: github,
}
const empty = {
  version: 1, enabled: false, one_time_url: null, monthly_url: null, manage_url: null, github_url: null,
  community_url: 'https://github.com/ColeLundstrom/printshopcrm/discussions',
  source_url: 'https://github.com/ColeLundstrom/printshopcrm',
}

test('unset configuration exposes community links and no payment choices or automatic Sponsors default', () => {
  for (const env of [{}, null, false, { PSC_PROJECT_SUPPORT_ONCE_URL: '', PSC_PROJECT_SUPPORT_GITHUB_URL: '' }])
    assert.deepEqual(projectSupportConfig(env), empty)
})

test('valid operator links have a stable public schema and never expose unrelated environment values', () => {
  const env = { ...fields, PSC_PLATFORM_STRIPE_SECRET: 'private-fixture', PSC_SOURCE_URL: 'https://other.invalid/source', ss_api_key: 'private-fixture' }
  assert.deepEqual(projectSupportConfig(env), { ...empty, enabled: true, one_time_url: once, monthly_url: monthly, manage_url: manage, github_url: github })
  assert.equal(JSON.stringify(projectSupportConfig(env)).includes('private-fixture'), false)
  assert.deepEqual(env, { ...fields, PSC_PLATFORM_STRIPE_SECRET: 'private-fixture', PSC_SOURCE_URL: 'https://other.invalid/source', ss_api_key: 'private-fixture' }, 'configuration does not mutate environment values')
})

test('monthly support requires a valid cancellation link and manage alone does not enable contributions', () => {
  assert.deepEqual(projectSupportConfig({ PSC_PROJECT_SUPPORT_MONTHLY_URL: monthly }), empty)
  assert.deepEqual(projectSupportConfig({ PSC_PROJECT_SUPPORT_MONTHLY_URL: monthly, PSC_PROJECT_SUPPORT_MANAGE_URL: 'https://billing.stripe.com.evil.invalid/p/login/id' }), empty)
  assert.deepEqual(projectSupportConfig({ PSC_PROJECT_SUPPORT_MANAGE_URL: manage }), { ...empty, manage_url: manage })
  assert.deepEqual(projectSupportConfig({ PSC_PROJECT_SUPPORT_ONCE_URL: once, PSC_PROJECT_SUPPORT_MONTHLY_URL: monthly }), { ...empty, enabled: true, one_time_url: once })
  assert.deepEqual(projectSupportConfig({ PSC_PROJECT_SUPPORT_GITHUB_URL: github }), { ...empty, enabled: true, github_url: github })
})

test('host, scheme, path and credential confusion cannot become an outbound funding URL', () => {
  const invalid = [
    'http://buy.stripe.com/id', '//buy.stripe.com/id', 'javascript:alert(1)', 'data:text/html,pay',
    'https://buy.stripe.com.evil.invalid/id', 'https://evil.invalid/buy.stripe.com/id',
    'https://user:secret@buy.stripe.com/id', 'https://buy.stripe.com@evil.invalid/id',
    'https://buy.stripe.com:443/id', 'https://buy.stripe.com:8443/id',
    'https://buy.stripe.com/id?prefilled_email=private', 'https://buy.stripe.com/id#section',
    'https://buy.stripe.com/id/extra', 'https://buy.stripe.com/id/', 'https://buy.stripe.com/',
    'https://buy.stripe.com/a/../id', 'https://buy.stripe.com/%69d', 'https://buy.stripe.com\\@evil.invalid/id',
    ' https://buy.stripe.com/id', 'https://buy.stripe.com/id\n', 'https://buy.stripe.com/id\0',
    'https://buy.stripe.com/i\u007fd', 'https://buy.stripe.com/idé', 'https://BUY.STRIPE.COM/id',
    `https://buy.stripe.com/${'a'.repeat(201)}`, 'x'.repeat(2049), null, 42, ['https://buy.stripe.com/id'],
  ]
  for (const value of invalid) {
    const result = projectSupportConfig({ ...fields, PSC_PROJECT_SUPPORT_ONCE_URL: value, PSC_PROJECT_SUPPORT_MONTHLY_URL: value })
    assert.equal(result.one_time_url, null, String(value))
    assert.equal(result.monthly_url, null, String(value))
    assert.equal(result.github_url, github, 'one invalid option does not remove another valid provider')
  }
})

test('provider-specific destinations and GitHub username bounds are enforced', () => {
  for (const value of [once, monthly, 'https://billing.stripe.com/p/session/id', `${manage}?return_url=https://example.invalid`, `${manage}/`, `${manage}#fragment`])
    assert.equal(projectSupportConfig({ PSC_PROJECT_SUPPORT_MANAGE_URL: value }).manage_url, null)
  for (const value of [once, manage, 'https://github.com/Fixture-Maintainer', 'https://github.com/sponsors/',
    'https://github.com/sponsors/-bad', 'https://github.com/sponsors/bad-', 'https://github.com/sponsors/bad--name',
    'https://github.com/sponsors/bad_name', `https://github.com/sponsors/${'a'.repeat(40)}`, `${github}?frequency=one-time`, `${github}/`])
    assert.equal(projectSupportConfig({ PSC_PROJECT_SUPPORT_GITHUB_URL: value }).github_url, null)
  for (const name of ['a', 'A-B', 'a'.repeat(39)]) {
    const url = `https://github.com/sponsors/${name}`
    assert.equal(projectSupportConfig({ PSC_PROJECT_SUPPORT_GITHUB_URL: url }).github_url, url)
  }
  assert.equal(projectSupportConfig({ PSC_PROJECT_SUPPORT_ONCE_URL: `https://buy.stripe.com/${'a'.repeat(200)}` }).enabled, true)
})

test('reading config never probes providers or changes tenant/hosting state', () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = () => { calls++; throw new Error('A config read must never contact a provider') }
  try {
    const seen = []
    const env = new Proxy(fields, { get(target, key) { seen.push(key); return target[key] } })
    assert.equal(projectSupportConfig(env).enabled, true)
    assert.equal(calls, 0)
    assert.deepEqual(new Set(seen), new Set(Object.keys(fields)))
  } finally { globalThis.fetch = originalFetch }
})
