// Pure, shared theme arithmetic. Only validated hex values reach generated CSS.
export const BRAND_THEMES = ['', 'dark', 'light', 'system']
export const validBrandColor = (v) => typeof v === 'string' && (v === '' || /^#[0-9a-f]{6}$/i.test(v))
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const hex = (a) => '#' + a.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t))
const luminance = (h) =>
  rgb(h)
    .map((v) => {
      v /= 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
export const contrast = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
function readable(color, background, target) {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, target, step / 100)
    if (contrast(candidate, background) >= 4.5) return candidate
  }
  return target
}
export function brandTokens(settings, mode) {
  const primary = validBrandColor(settings.brand_primary) ? settings.brand_primary : '',
    secondary = validBrandColor(settings.brand_secondary) ? settings.brand_secondary : ''
  if (!primary && !secondary) return {}
  const dark = mode === 'dark',
    surface = dark ? '#1b2029' : '#eceff4',
    target = dark ? '#ffffff' : '#000000'
  const accent = readable(primary || (dark ? '#10d39a' : '#047857'), surface, target)
  const second = readable(secondary || (dark ? '#8b7cff' : '#6f5cf0'), surface, target)
  const ink = contrast(accent, '#000000') >= contrast(accent, '#ffffff') ? '#000000' : '#ffffff'
  return {
    '--accent': accent,
    '--accent-2': accent,
    '--accent-ink': ink,
    '--accent-dim': readable(primary || '#047857', '#eafff8', '#000000'),
    '--accent-glow': `rgba(${rgb(accent).join(',')},.14)`,
    '--violet': second,
    '--violet-solid': readable(secondary || '#5a46e0', '#ffffff', '#000000'),
    '--grad': `linear-gradient(135deg,${accent},${second})`,
    '--grad-soft': `linear-gradient(135deg,rgba(${rgb(accent).join(',')},.14),rgba(${rgb(second).join(',')},.14))`
  }
}
export const brandCss = (settings) =>
  ['dark', 'light']
    .map(
      (mode) =>
        `:root[data-theme="${mode}"]{${Object.entries(brandTokens(settings, mode))
          .map(([k, v]) => `${k}:${v}`)
          .join(';')}}`
    )
    .join('')
