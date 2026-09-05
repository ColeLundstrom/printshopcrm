/** Public, operator-configured outbound links. No tenant settings, provider SDK or network I/O.
 * Validation checks URL shape only. The operator must verify recipient, billing frequency and
 * cancellation before configuring a link; a matching URL is not proof of an active checkout.
 */
const SOURCE = 'https://github.com/ColeLundstrom/printshopcrm'
const PAYMENT = /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_]{1,200}$/
const MANAGE = /^https:\/\/billing\.stripe\.com\/p\/login\/[A-Za-z0-9_]{1,200}$/
const SPONSORS = /^https:\/\/github\.com\/sponsors\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)$/

function link(value, pattern) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) return null
  return pattern.test(value) ? value : null
}

export function projectSupportConfig(env = process.env) {
  const settings = env && typeof env === 'object' ? env : {}
  const one_time_url = link(settings.PSC_PROJECT_SUPPORT_ONCE_URL, PAYMENT)
  const manage_url = link(settings.PSC_PROJECT_SUPPORT_MANAGE_URL, MANAGE)
  const monthly_url = manage_url ? link(settings.PSC_PROJECT_SUPPORT_MONTHLY_URL, PAYMENT) : null
  let github_url = link(settings.PSC_PROJECT_SUPPORT_GITHUB_URL, SPONSORS)
  if (github_url?.slice('https://github.com/sponsors/'.length).includes('--')) github_url = null
  return {
    version: 1,
    enabled: Boolean(one_time_url || monthly_url || github_url),
    one_time_url, monthly_url, manage_url, github_url,
    community_url: `${SOURCE}/discussions`, source_url: SOURCE,
  }
}
