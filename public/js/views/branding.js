/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4 */
import { api, $, $$, esc, setPage, toast, guardLeave, confirmModal, go } from '../core.js'
import { brandTokens, validBrandColor } from '../shared/branding.js'
import { applyShopBranding } from '../shop-branding.js'
let dirty = false
window.addEventListener('beforeunload', (e) => {
  if (dirty && location.hash === '#/branding') {
    e.preventDefault()
    e.returnValue = ''
  }
})
export async function brandingView() {
  setPage('Make it yours', '<a class="btn ghost" href="#/setup">Setup guide</a>')
  if (window.__me?.can_manage === false) {
    $('#view').innerHTML =
      '<p>An owner or manager changes the shop’s branding. You can switch light and dark mode from the header.</p>'
    return
  }
  const { settings: s } = await api.get('/api/settings')
  dirty = false
  const colorField = (key, label, fallback) =>
    `<div class="field"><label for="${key}">${label}</label><div class="brand-color"><input type="color" aria-label="${label} picker" data-picker="${key}" value="${esc(s[key] || fallback)}"><input class="input" id="${key}" name="${key}" value="${esc(s[key] || '')}" placeholder="Default" maxlength="7" pattern="#[0-9a-fA-F]{6}|" autocomplete="off"></div></div>`
  $('#view').innerHTML =
    `<div class="branding-workspace"><p>Your logo, workspace name and colors belong to this shop. Everyone on your team sees the same branding; each person can switch appearance on their device.</p><div class="branding-layout"><section class="card card-b"><h2>Your shop identity</h2><div class="logo-row"><div class="logo-prev" id="brand-logo-preview"></div><div><input id="brand-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden><button class="btn ghost" id="brand-upload">Upload logo</button><button class="btn ghost" id="brand-remove" ${s.shop_logo ? '' : 'hidden'}>Remove logo</button><p class="dim">PNG, JPG, WebP, GIF or SVG, up to 5 MB. Logo changes save immediately and appear on customer documents.</p></div></div><form id="branding-form"><label class="field" for="workspace-name">Workspace name<input class="input" id="workspace-name" name="brand_name" maxlength="120" required value="${esc(s.brand_name)}"></label><label class="field" for="workspace-tag">Workspace tagline<input class="input" id="workspace-tag" name="brand_tagline" maxlength="180" value="${esc(s.brand_tagline)}"></label><h3>Colors & appearance</h3><div class="brand-color-grid">${colorField('brand_primary', 'Primary color', '#10d39a')}${colorField('brand_secondary', 'Secondary color', '#8b7cff')}</div><label class="field" for="brand-appearance">Default appearance<select class="input" id="brand-appearance" name="brand_theme">${[
      ['', 'Default'],
      ['system', 'Follow device'],
      ['light', 'Light'],
      ['dark', 'Dark']
    ]
      .map(([v, label]) => `<option value="${v}" ${s.brand_theme === v ? 'selected' : ''}>${label}</option>`)
      .join(
        ''
      )}</select></label><p class="dim">Preview before saving. We adjust shades to keep links and buttons readable; alerts keep their meaning. Leave colors blank for the defaults.</p><div class="brand-actions"><button class="btn primary">Save branding</button><button class="btn ghost" type="button" id="brand-reset">Reset colors</button></div><p id="branding-status" role="status"></p></form></section><section aria-label="Branding preview"><h2>Preview</h2><div id="brand-previews"></div><p class="dim">Example interface only. No order or payment is created.</p></section></div><p class="dim">Your workspace stays open source. Source and license links remain available.</p></div>`
  const form = $('#branding-form')
  const values = () => Object.fromEntries(new FormData(form))
  const showLogo = () => {
    const f = s.shop_logo
    $('#brand-logo-preview').innerHTML = f
      ? `<img src="/uploads/${encodeURIComponent(f)}" alt="Shop logo">`
      : '<span class="dim">No logo</span>'
    $('#brand-remove').hidden = !f
  }
  const preview = () => {
    const v = values()
    $('#brand-previews').innerHTML = ['light', 'dark']
      .map(
        (mode) =>
          `<div class="branding-preview ${mode}" data-preview="${mode}"><div class="brand-preview-head">${s.shop_logo ? `<img src="/uploads/${encodeURIComponent(s.shop_logo)}" alt="Shop logo">` : ''}<div><strong>${esc(v.brand_name || 'Your workspace')}</strong><p>${esc(v.brand_tagline)}</p></div></div><small>${mode === 'light' ? 'Light' : 'Dark'} appearance</small><h3>Ready for production</h3><p class="preview-muted">The next task, in your shop’s colors.</p><div class="brand-actions"><span class="preview-button">Open job</span><span class="preview-link">View workflow</span></div></div>`
      )
      .join('')
    for (const mode of ['dark', 'light'])
      for (const [k, value] of Object.entries(brandTokens(v, mode)))
        $(`[data-preview="${mode}"]`).style.setProperty(k, value)
  }
  showLogo()
  preview()
  form.addEventListener('input', (e) => {
    dirty = true
    $('#branding-status').textContent = 'Preview updated · not saved'
    const key = e.target.dataset.picker
    if (key) form.elements[key].value = e.target.value
    else if (
      ['brand_primary', 'brand_secondary'].includes(e.target.name) &&
      e.target.value &&
      validBrandColor(e.target.value)
    )
      $(`[data-picker="${e.target.name}"]`).value = e.target.value
    preview()
  })
  $('#brand-reset').onclick = () => {
    for (const key of ['brand_primary', 'brand_secondary']) form.elements[key].value = ''
    $('[data-picker="brand_primary"]').value = '#10d39a'
    $('[data-picker="brand_secondary"]').value = '#8b7cff'
    form.elements.brand_theme.value = ''
    dirty = true
    $('#branding-status').textContent = 'Default colors previewed · save to apply'
    preview()
  }
  form.onsubmit = async (e) => {
    e.preventDefault()
    const v = values()
    if (!validBrandColor(v.brand_primary) || !validBrandColor(v.brand_secondary))
      return toast('Use a six-digit hex color or leave it blank.', true)
    try {
      const saved = await api.put('/api/settings', v)
      Object.assign(s, saved)
      dirty = false
      applyShopBranding(s, { resetTheme: true })
      window.dispatchEvent(new Event('psc:settings'))
      $('#branding-status').textContent = 'Branding saved for your shop'
      toast('Branding saved')
    } catch (err) {
      toast(err.message, true)
    }
  }
  $('#brand-upload').onclick = () => $('#brand-file').click()
  $('#brand-file').onchange = async () => {
    const file = $('#brand-file').files[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) return toast('Use a logo smaller than 5 MB.', true)
    const b = $('#brand-upload')
    b.disabled = true
    try {
      const body = new FormData()
      body.append('file', file)
      const r = await fetch('/api/settings/logo', { method: 'POST', body })
      const d = await r.json()
      if (!r.ok) throw Error(d.error || 'Upload failed')
      s.shop_logo = d.shop_logo
      showLogo()
      preview()
      applyShopBranding(s)
      toast('Logo saved')
    } catch (err) {
      toast(err.message, true)
    } finally {
      b.disabled = false
      $('#brand-file').value = ''
    }
  }
  $('#brand-remove').onclick = async () => {
    try {
      await api.del('/api/settings/logo')
      s.shop_logo = ''
      showLogo()
      preview()
      applyShopBranding(s)
      toast('Logo removed')
    } catch (err) {
      toast(err.message, true)
    }
  }
  guardLeave((to) => {
    if (!dirty) return true
    confirmModal(
      'Leave without saving colors?',
      'Your logo is saved, but these color and name changes are only a preview.',
      () => {
        dirty = false
        go(to)
      },
      'Discard changes'
    )
    return false
  })
}
