/**
 * Real per-decoration cost + sell models — so a shop can quote embroidery, DTF, UV DTF, patches,
 * and laser with genuine cost data, not a multiplier guess. Ported from the Merch Troop pricing
 * policy (v2026-05, calibrated against real vendor cost sheets). Screen print keeps its own richer
 * qty×colors + press-time engine in pricing.js — this covers everything else.
 *
 * Pure functions, no dependencies, imported by both the browser and the server.
 */
import { round2 } from './pricing.js'

export const SERVICE_MARGINS = { transfer: 50, embroidery: 45, patch: 45, laser: 45 } // % margin
const marginPrice = (cost, marginPct) => {
  const c = Number(cost) || 0
  const m = Math.min(99.9, Math.max(0, Number(marginPct) || 0))
  return c / (1 - m / 100)
}

/* ---------- DTF / UV DTF: priced by print area (sq in) ---------- */
export const dtfCost = (widthIn = 12, heightIn = 14) => (Number(widthIn) || 0) * (Number(heightIn) || 0) * 0.03 + 1.50
export const uvdtfCost = (widthIn = 12, heightIn = 14) => (Number(widthIn) || 0) * (Number(heightIn) || 0) * 0.05 + 1.50
export const dtfSell = (widthIn, heightIn) => round2(marginPrice(dtfCost(widthIn, heightIn), SERVICE_MARGINS.transfer))
export const uvdtfSell = (widthIn, heightIn) => round2(marginPrice(uvdtfCost(widthIn, heightIn), SERVICE_MARGINS.transfer))

/* ---------- Embroidery: flat cost, or live-digitized tier ---------- */
export const embroideryCost = (qty, { live = false } = {}) => (live ? ((Number(qty) || 0) >= 150 ? 15 : 20) : 7)
export const embroiderySell = (qty, opts = {}) => round2(marginPrice(embroideryCost(qty, opts), SERVICE_MARGINS.embroidery))
export const EMBROIDERY_DIGITIZING_FEE = 60

/* ---------- Laser: per-piece by quantity tier ---------- */
export const laserSell = (qty) => { const q = Number(qty) || 0; return q >= 1000 ? 4 : q >= 500 ? 6 : 8 }

/* ---------- Patches: real vendor cost matrix (size × qty break) + application ---------- */
export const PATCH_RAW_COSTS = {
  '2': { 10: 7.14, 20: 4.40, 50: 2.00, 100: 1.30, 200: 0.77, 300: 0.68, 500: 0.55, 1000: 0.38, 2000: 0.37, 5000: 0.35, 10000: 0.33 },
  '2.5': { 10: 8.59, 20: 4.63, 50: 2.27, 100: 1.47, 200: 1.11, 300: 0.93, 500: 0.64, 1000: 0.46, 2000: 0.45, 5000: 0.44, 10000: 0.43 },
  '3': { 10: 9.82, 20: 5.70, 50: 2.98, 100: 1.66, 200: 1.18, 300: 1.14, 500: 0.80, 1000: 0.53, 2000: 0.49, 5000: 0.46, 10000: 0.44 },
  '3.5': { 10: 12.46, 20: 6.46, 50: 3.24, 100: 1.77, 200: 1.30, 300: 1.22, 500: 0.95, 1000: 0.68, 2000: 0.62, 5000: 0.60, 10000: 0.58 },
  '4': { 10: 13.45, 20: 7.54, 50: 3.36, 100: 2.00, 200: 1.42, 300: 1.31, 500: 1.11, 1000: 0.86, 2000: 0.79, 5000: 0.76, 10000: 0.71 },
  '4.5': { 10: 14.48, 20: 8.60, 50: 3.85, 100: 2.41, 200: 1.65, 300: 1.58, 500: 1.28, 1000: 0.99, 2000: 0.91, 5000: 0.89, 10000: 0.87 },
  '5': { 10: 15.41, 20: 10.09, 50: 4.51, 100: 2.66, 200: 2.11, 300: 1.83, 500: 1.38, 1000: 1.16, 2000: 1.07, 5000: 1.05, 10000: 1.03 },
  '5.5': { 10: 17.40, 20: 11.61, 50: 5.29, 100: 3.25, 200: 2.35, 300: 1.96, 500: 1.65, 1000: 1.42, 2000: 1.33, 5000: 1.31, 10000: 1.29 },
}
const PATCH_BREAKS = [10, 20, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000]
const patchSizeKey = (sizeIn = 3) => {
  const size = Number(sizeIn) || 3
  const keys = Object.keys(PATCH_RAW_COSTS).map(Number).sort((a, b) => a - b)
  let sel = keys[0]
  for (const k of keys) { sel = k; if (size <= k) break }
  return String(sel)
}
const patchQtyBreak = (qty) => { const q = Number(qty) || 0; let sel = 10; for (const b of PATCH_BREAKS) if (q >= b) sel = b; return sel }
export const patchRawCost = (qty, sizeIn = 3) => PATCH_RAW_COSTS[patchSizeKey(sizeIn)][patchQtyBreak(qty)]
export const patchSell = (qty, sizeIn = 3, applicationCost = 1.50) => round2(marginPrice(patchRawCost(qty, sizeIn) + applicationCost, SERVICE_MARGINS.patch))

/* ---------- unified helper the calculator calls for non-screen methods ---------- */

export const SERVICE_METHODS = ['DTF Transfer', 'UV DTF', 'Embroidery', 'Patch', 'Laser']

/**
 * Per-piece sell price + cost for a non-screen decoration, with real cost data. Returns null for
 * Screen Print (use the screen-print engine instead). `opts`: { widthIn, heightIn, patchSizeIn,
 * liveEmbroidery }.
 */
export function servicePerPiece(method, qty, opts = {}) {
  const q = Number(qty) || 0
  switch (method) {
    case 'DTF Transfer': return { sell: dtfSell(opts.widthIn ?? 10, opts.heightIn ?? 12), cost: round2(dtfCost(opts.widthIn ?? 10, opts.heightIn ?? 12)), basis: `${opts.widthIn ?? 10}×${opts.heightIn ?? 12}″ print` }
    case 'UV DTF': return { sell: uvdtfSell(opts.widthIn ?? 4, opts.heightIn ?? 4), cost: round2(uvdtfCost(opts.widthIn ?? 4, opts.heightIn ?? 4)), basis: `${opts.widthIn ?? 4}×${opts.heightIn ?? 4}″ decal` }
    case 'Embroidery': return { sell: embroiderySell(q, { live: !!opts.liveEmbroidery }), cost: round2(embroideryCost(q, { live: !!opts.liveEmbroidery })), basis: opts.liveEmbroidery ? 'live-digitized' : 'standard stitch', fee: EMBROIDERY_DIGITIZING_FEE, feeLabel: 'digitizing (one-time)' }
    case 'Patch': return { sell: patchSell(q, opts.patchSizeIn ?? 3), cost: round2(patchRawCost(q, opts.patchSizeIn ?? 3) + 1.5), basis: `${opts.patchSizeIn ?? 3}″ patch + application` }
    case 'Laser': return { sell: laserSell(q), cost: null, basis: 'engrave, per-piece tier' }
    default: return null
  }
}
