import { store } from './core.js'
import { brandCss } from './shared/branding.js'
let brandTheme = null
const preferenceKey = () => `psc-theme:${window.__me?.slug || 'local'}`
const systemTheme = () => (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
export function applyShopBranding(settings, { resetTheme = false } = {}) {
  let style = document.getElementById('shop-brand-theme')
  if (!style) {
    style = document.createElement('style')
    style.id = 'shop-brand-theme'
    document.head.append(style)
  }
  style.textContent = brandCss(settings)
  if (resetTheme) {
    try {
      localStorage.removeItem(preferenceKey())
    } catch {}
  }
  const preferred = store.get(preferenceKey())
  if (brandTheme === null || resetTheme || brandTheme !== settings.brand_theme) {
    const mode = ['light', 'dark'].includes(preferred)
      ? preferred
      : ['light', 'dark'].includes(settings.brand_theme)
        ? settings.brand_theme
        : settings.brand_theme === 'system'
          ? systemTheme()
          : store.get('psc-theme') || (window.__EDITION === 'lite' ? 'light' : systemTheme())
    document.documentElement.dataset.theme = ['light', 'dark'].includes(mode) ? mode : systemTheme()
  }
  brandTheme = settings.brand_theme
  const logo = document.getElementById('brand-logo')
  if (logo) {
    const valid = /^[a-zA-Z0-9._-]+$/.test(settings.shop_logo || '')
    logo.hidden = !valid
    if (valid) {
      logo.src = '/uploads/' + encodeURIComponent(settings.shop_logo)
      logo.alt = settings.shop_name + ' logo'
    } else logo.removeAttribute('src')
  }
}
export function toggleShopTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  document.documentElement.dataset.theme = next
  store.set(preferenceKey(), next)
  store.set('psc-theme', next)
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (brandTheme === 'system' && !store.get(preferenceKey()))
    document.documentElement.dataset.theme = systemTheme()
})
