/**
 * DTF gang-sheet nesting + pricing. Pure math (inches), shared by the embeddable customer
 * builder and the server price check so the number the customer sees is the number that's
 * charged. Shelf/row packing: tall items first, packed left→right into rows the width of the
 * roll. Good enough to fill a sheet densely without a full 2D bin-packer.
 */

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * @param items  [{ w, h, qty }] print sizes in inches
 * @param opts   { sheetWidth=22, gap=0.25 }
 * @returns { placements:[{x,y,w,h,i}], usedHeight, sheetWidth, count }
 */
const MAX_BOXES = 5000 // hard cap: nesting is O(boxes); an unbounded qty from the public embed
                       // must never be able to spin the CPU or exhaust memory.
export function nest(items, { sheetWidth = 22, gap = 0.25 } = {}) {
  const boxes = []
  for (const [i, it] of (Array.isArray(items) ? items : []).slice(0, 500).entries()) {
    const w = Math.min(Number(it.w) || 0, sheetWidth)
    const h = Number(it.h) || 0
    const qty = Math.min(Math.max(0, Math.floor(Number(it.qty) || 0)), MAX_BOXES)
    for (let n = 0; n < qty && boxes.length < MAX_BOXES; n++) if (w > 0 && h > 0) boxes.push({ w, h, i })
    if (boxes.length >= MAX_BOXES) break
  }
  boxes.sort((a, b) => b.h - a.h) // tallest first → tidy shelves

  const placements = []
  let x = 0, y = 0, rowH = 0
  for (const b of boxes) {
    if (x + b.w > sheetWidth + 1e-6) { x = 0; y += rowH + gap; rowH = 0 } // new shelf
    placements.push({ x, y, w: b.w, h: b.h, i: b.i })
    x += b.w + gap
    rowH = Math.max(rowH, b.h)
  }
  const usedHeight = placements.length ? round2(y + rowH) : 0
  return { placements, usedHeight, sheetWidth, count: placements.length }
}

/**
 * Price a nested sheet. DTF is sold by the running length of a fixed-width roll, so the charge
 * is the length used (rounded up to whole inches) × price/inch, with a minimum.
 */
export function priceSheet(usedHeight, { pricePerInch = 0.95, minCharge = 8, setup = 0 } = {}) {
  const inches = Math.ceil(usedHeight)
  const raw = round2(inches * pricePerInch + setup)
  return { inches, feet: round2(inches / 12), subtotal: Math.max(raw, minCharge), atMinimum: raw < minCharge }
}
