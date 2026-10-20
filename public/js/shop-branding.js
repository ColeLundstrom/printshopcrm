import { store } from './core.js'
import { brandCss } from './shared/branding.js'
let brandTheme = null
const preferenceKey = () => `psc-theme:${window.__me?.slug || 'local'}`
const systemTheme = () => (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
/* The browser chrome (mobile address bar, installed-PWA title bar) is painted from
 * <meta name="theme-color">, which the shell ships as the dark background. Keep it on the active
 * theme's --bg, including a shop's brand override, so light mode does not sit under a black bar. */
function setTheme(mode) {
  document.documentElement.dataset.theme = mode
  syncThemeColor()
}
export function syncThemeColor() {
  const meta = document.querySelector?.('meta[name="theme-color"]')
  if (!meta || typeof getComputedStyle !== 'function') return
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  if (bg) meta.setAttribute('content', bg)
}
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
    setTheme(['light', 'dark'].includes(mode) ? mode : systemTheme())
  } else syncThemeColor()   // the brand CSS above may have changed --bg without a theme flip
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
  setTheme(next)
  store.set(preferenceKey(), next)
  store.set('psc-theme', next)
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (brandTheme === 'system' && !store.get(preferenceKey()))
    setTheme(systemTheme())
})
