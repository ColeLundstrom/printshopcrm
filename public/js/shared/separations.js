/**
 * Color separation engine — the Separation Studio core.
 *
 * A screen printer can't print a photo; they print one screen per ink color. Separation is
 * turning artwork into those screens: which inks, and where each ink lands. This module is
 * the math, kept pure (operates on plain {width,height,data} RGBA buffers) so it runs the
 * same in the browser canvas and in a Node test.
 *
 * Two modes a shop actually uses:
 *   - spot:   quantize the art to N solid inks, one screen each. Best for logos/vector-ish art.
 *   - process: fix the ink set (the sim-process palette) and separate onto it. Best for
 *              photographic / many-color art printed on a handful of screens.
 *
 * Dark garments add a white underbase screen printed first, so the colors sit on white
 * instead of the shirt. Forgetting it is the "1-color on black is really 2 colors" trap.
 */

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
export const rgbToHex = ([r, g, b]) => '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')
export function hexToRgb(hex) {
  const h = String(hex).replace('#', '')
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)]
}
export const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

/** Standard simulated-process ink set — the screens a shop keeps on the rack. */
export const SIM_PROCESS_INKS = [
  { name: 'White', rgb: [245, 245, 245] },
  { name: 'Black', rgb: [20, 20, 20] },
  { name: 'Red', rgb: [200, 30, 40] },
  { name: 'Yellow', rgb: [245, 210, 30] },
  { name: 'Blue', rgb: [30, 70, 170] },
  { name: 'Green', rgb: [40, 150, 70] },
]

/** Common garment colors for the preview background. */
export const GARMENT_COLORS = [
  { name: 'White', hex: '#f4f4f4', dark: false },
  { name: 'Black', hex: '#151515', dark: true },
  { name: 'Navy', hex: '#1b2a44', dark: true },
  { name: 'Heather', hex: '#9aa0a6', dark: false },
  { name: 'Red', hex: '#7a1f24', dark: true },
  { name: 'Sand', hex: '#d8cbb0', dark: false },
]

/**
 * k-means over a sampled subset of opaque pixels. Sampling keeps it fast on big images;
 * the returned centroids are the recommended ink colors, sorted light→dark so the underbase
 * and highlight screens read in a sensible order.
 */
export function quantize({ data, width, height }, k = 4, { samples = 6000, iterations = 12 } = {}) {
  const px = []
  const total = width * height
  const step = Math.max(1, Math.floor(total / samples))
  for (let i = 0; i < total; i += step) {
    const o = i * 4
    if (data[o + 3] < 128) continue // ignore transparent
    px.push([data[o], data[o + 1], data[o + 2]])
  }
  if (!px.length) return []
  k = clamp(k, 1, Math.min(12, px.length))

  // k-means++ seeding so runs are stable and clusters spread out.
  const cents = [px[Math.floor(px.length / 2)]]
  while (cents.length < k) {
    let best = px[0], bestD = -1
    for (let s = 0; s < px.length; s += Math.max(1, Math.floor(px.length / 400))) {
      const p = px[s]
      const d = Math.min(...cents.map((c) => dist2(p, c)))
      if (d > bestD) { bestD = d; best = p }
    }
    cents.push(best)
  }

  const assign = new Array(px.length).fill(0)
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < px.length; i++) {
      let bi = 0, bd = Infinity
      for (let c = 0; c < cents.length; c++) { const d = dist2(px[i], cents[c]); if (d < bd) { bd = d; bi = c } }
      assign[i] = bi
    }
    const sums = cents.map(() => [0, 0, 0, 0])
    for (let i = 0; i < px.length; i++) { const s = sums[assign[i]]; s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++ }
    for (let c = 0; c < cents.length; c++) if (sums[c][3]) cents[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]]
  }

  const counts = cents.map(() => 0)
  for (const a of assign) counts[a]++
  return cents
    .map((rgb, i) => ({ rgb: rgb.map(Math.round), hex: rgbToHex(rgb), share: counts[i] / px.length }))
    .filter((c) => c.share > 0.004) // drop inks that touch almost nothing
    .sort((a, b) => luminance(b.rgb) - luminance(a.rgb))
}

/** Nearest ink in a fixed set — the assignment step for simulated-process mode. */
export const nearestInk = (rgb, inks) => inks.reduce((best, ink) => {
  const d = dist2(rgb, ink.rgb)
  return d < best.d ? { ink, d } : best
}, { ink: inks[0], d: Infinity }).ink

/**
 * Build one separation channel per ink. Each channel is a coverage map: 0 = no ink here,
 * 255 = full ink. A pixel goes to whichever ink is closest, weighted so that a near-perfect
 * match prints solid and a loose match prints as a lighter halftone.
 *
 * Returns { inks, coverage: Uint8Array[] } aligned with `inks`.
 */
export function separate({ data, width, height }, inks, { softness = 90 } = {}) {
  const n = width * height
  const coverage = inks.map(() => new Uint8Array(n))
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (data[o + 3] < 128) continue
    const rgb = [data[o], data[o + 1], data[o + 2]]
    let bi = 0, bd = Infinity
    for (let c = 0; c < inks.length; c++) { const d = dist2(rgb, inks[c].rgb); if (d < bd) { bd = d; bi = c } }
    // Distance → coverage: closer match = more ink. softness sets how fast it falls off.
    const cov = clamp(255 - Math.sqrt(bd) * (softness / 100), 40, 255)
    coverage[bi][i] = cov
  }
  return { inks, coverage, width, height }
}

/**
 * White underbase coverage: wherever any colored ink lands on a dark garment, print white
 * first. Coverage tracks how much ink is there so the underbase halftones with the art.
 */
export function underbase({ coverage, width, height }, inks) {
  const n = width * height
  const ub = new Uint8Array(n)
  for (let c = 0; c < inks.length; c++) {
    // A white ink doesn't need a white underbase under itself.
    if (luminance(inks[c].rgb) > 225) continue
    const cov = coverage[c]
    for (let i = 0; i < n; i++) if (cov[i] > ub[i]) ub[i] = cov[i]
  }
  return ub
}

/** How many screens a job needs = colored inks (+1 for the underbase on a dark garment). */
export function screenCount(inks, dark) {
  const base = inks.length
  return dark && inks.some((k) => luminance(k.rgb) <= 225) ? base + 1 : base
}

/** A friendly ink name from its color — shops label screens by name, not hex. */
export function inkName(rgb) {
  const [r, g, b] = rgb
  const l = luminance(rgb)
  if (l > 230) return 'White'
  if (l < 28) return 'Black'
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  if (max - min < 26) return l > 150 ? 'Light Gray' : 'Gray'
  // Yellow/orange sit in the red-dominant zone, so name them before the generic red branch.
  if (r > 170 && g > 140 && b < 120) return g > 190 ? 'Yellow' : 'Orange'
  if (r >= g && r >= b) return b > 120 ? 'Pink' : 'Red'
  if (g >= r && g >= b) return r > 150 ? 'Lime' : 'Green'
  if (b >= r && b >= g) return r > 120 ? 'Purple' : g > 120 ? 'Teal' : 'Blue'
  return 'Spot'
}
