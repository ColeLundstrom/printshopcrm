/* Hallmark · pre-emit critique: P5 H4 E4 S5 R5 V4. Existing workbench tokens only. */
import { api, $, esc, setPage } from '../core.js'

const REPOSITORY = 'https://github.com/ColeLundstrom/printshopcrm'

function supportStyles() {
  if (document.querySelector('link[data-project-support]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'; link.href = '/css/project-support.css'; link.dataset.projectSupport = ''
  document.head.append(link)
}

// Defense in depth for links supplied by configuration. Nothing starts a payment in this app.
// Match the server's small allowlist; do not turn an arbitrary URL into a checkout button.
export function projectSupportLinks(data) {
  const safe = (value, pattern) => typeof value === 'string' && value.length <= 2048 && !/[\s\u0000-\u001f\u007f]/.test(value) && pattern.test(value) ? value : null
  if (data?.version !== 1) return { oneTime: null, monthly: null, manage: null, github: null }
  const manage = safe(data.manage_url, /^https:\/\/billing\.stripe\.com\/p\/login\/[A-Za-z0-9_]{1,200}$/)
  // Existing supporters still need cancellation access if new contributions are switched off.
  if (data.enabled !== true) return { oneTime: null, monthly: null, manage, github: null }
  const oneTime = safe(data.one_time_url, /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_]{1,200}$/)
  const monthly = manage ? safe(data.monthly_url, /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_]{1,200}$/) : null
  const github = safe(data.github_url, /^https:\/\/github\.com\/sponsors\/[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/)
  return { oneTime, monthly, manage, github }
}

const external = (url, label, className = '') => `<a${className ? ` class="${className}"` : ''} href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(label)} (opens in a new tab)">${esc(label)}</a>`

export function projectSupportOptions(data) {
  const links = projectSupportLinks(data)
  const separateManage = links.manage && !links.monthly ? `<p class="ps-existing-support">${external(links.manage, 'Manage monthly support', 'ps-manage-link')}</p>` : ''
  if (!links.oneTime && !links.monthly && !links.github) return `<p class="ps-unconfigured">Contribution checkout is not configured. You can still help through the community below.</p>${separateManage}`
  const row = (title, description, link, label, extra = '') => `<div class="ps-support-row"><div><h3>${title}</h3><p>${description}</p></div><div class="ps-row-actions">${external(link, label, 'btn ghost')}${extra}</div></div>`
  return `<div class="ps-support-options">
    ${links.oneTime ? row('One-time contribution', 'Help cover ongoing maintenance and improvements.', links.oneTime, 'Contribute once') : ''}
    ${links.monthly ? row('Monthly contribution', 'Provide recurring support for continued project upkeep.', links.monthly, 'Contribute monthly', external(links.manage, 'Manage monthly support', 'ps-manage-link')) : ''}
    ${links.github ? row('GitHub Sponsors', 'Contribute through the project’s configured GitHub sponsor page.', links.github, 'Support on GitHub') : ''}
  </div>${separateManage}<p class="ps-checkout-note">Review the amount and billing frequency at checkout before paying. Payment links open in a new tab.</p>`
}

export async function projectSupportView() {
  supportStyles()
  setPage('Support the project')
  $('#view').innerHTML = `<article class="project-support" aria-labelledby="ps-title">
    <header class="ps-intro"><h2 id="ps-title">Free software, maintained together</h2><p>PrintShopCRM is free and open source under ${external(`${REPOSITORY}/blob/main/LICENSE`, 'AGPL-3.0')}. Every feature is available without a software subscription. You can run your shop manually; AI is optional.</p></header>
    <section class="ps-funding" aria-labelledby="ps-funding-title"><h2 id="ps-funding-title" tabindex="-1">Help maintain the project</h2><p class="ps-funding-description">Voluntary contributions help fund maintenance, documentation, change review and work from outside contributors. All features stay available to every shop.</p><div id="ps-payment-options" aria-busy="true"><p class="ps-loading" role="status">Loading contribution options…</p></div></section>
    <section class="ps-community" aria-labelledby="ps-community-title"><h2 id="ps-community-title">Help in other ways</h2><p>You know what a print shop needs. Share that experience, whether or not you write code.</p>
      <ul class="ps-community-list">
        <li><div>${external(`${REPOSITORY}/blob/main/CONTRIBUTING.md`, 'Contribute code')}<p>Fix a bug or improve a workflow. Start with the contribution guide and required checks.</p></div></li>
        <li><div>${external(`${REPOSITORY}/tree/main/docs`, 'Improve documentation')}<p>Help another shop get set up with clearer instructions and examples.</p></div></li>
        <li><div>${external(`${REPOSITORY}/issues/new/choose`, 'Report a bug')}<p>Describe what happened, what you expected and how to reproduce it. Use sample data.</p></div></li>
        <li><div>${external(`${REPOSITORY}/discussions`, 'Test with the community')}<p>Try changes with sample jobs and share feedback from your department or decoration method.</p></div></li>
      </ul>
    </section>
    <footer class="ps-footer">${external(REPOSITORY, 'View the source code')}<span>Community links open on GitHub in a new tab.</span></footer>
  </article>`
  const root = $('.project-support'), options = $('#ps-payment-options', root)
  let loading = false
  async function loadOptions(focusAfter = false) {
    if (loading || !root.isConnected) return
    loading = true; options.setAttribute('aria-busy', 'true')
    options.innerHTML = '<p class="ps-loading" role="status">Loading contribution options…</p>'
    try {
      const data = await api.get('/api/project-support')
      if (!root.isConnected) return
      if (data?.version !== 1) throw new Error('Unsupported support configuration')
      options.innerHTML = projectSupportOptions(data)
    } catch {
      if (!root.isConnected) return
      options.innerHTML = '<div class="ps-load-error"><p role="alert">Contribution options could not be loaded. The community links below are still available.</p><button type="button" class="btn ghost" id="ps-retry">Try again</button></div>'
      $('#ps-retry', root).addEventListener('click', () => loadOptions(true))
    } finally {
      loading = false
      if (root.isConnected) {
        options.setAttribute('aria-busy', 'false')
        if (focusAfter) ($('#ps-retry', root) || $('#ps-funding-title', root)).focus({ preventScroll: true })
      }
    }
  }
  await loadOptions()
}
