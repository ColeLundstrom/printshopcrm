import { appRequestAllowed } from './isolation.mjs'

/** Use the real mobile drawer; the desktop breadcrumb is intentionally hidden on phones. */
export async function leaveQuoteForEstimateList(page, mobile) {
  if (mobile) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.locator('#nav').getByRole('link', { name: 'Estimates', exact: true }).click()
  } else await page.locator('#crumb a[href="#/estimates"]').click()
}

/** Cookie replacement alone does not reload an already-open same-document hash route. */
export async function switchReadOnlyTenant(page, context, cookie, expectedSlug) {
  if (!appRequestAllowed(page.url(), cookie.url) || new URL(page.url()).pathname !== '/'
    || cookie.name !== 'psc_session' || typeof expectedSlug !== 'string' || !expectedSlug)
    throw Error('Tenant switch requires the synthetic app origin and an expected shop')
  await context.clearCookies()
  await context.addCookies([cookie])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(slug => window.__me?.slug === slug, expectedSlug)
}
