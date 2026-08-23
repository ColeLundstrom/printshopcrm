/**
 * DTF trim + resize-to-print-size — the everyday tool a DTF shop reaches for constantly.
 *
 * Auto-trims the transparent margin off a PNG (so the print lands exactly where the art is), then
 * resamples it to a precise physical size (inches × DPI) and writes the DPI into the PNG's pHYs
 * chunk so the RIP prints it at true size. All client-side canvas + byte work — no upload, no
 * server, the art never leaves the browser. Ported from the Merch Troop portal's proven tool.
 */

/* ---------- PNG byte helpers ---------- */
const asciiBytes = (s) => Uint8Array.from(String(s), (c) => c.charCodeAt(0))
const isPng = (b) => b?.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10
const readUint32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const writeUint32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255 }
const readAscii = (b, o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); return s }

let CRC_TABLE = null
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); CRC_TABLE[n] = c >>> 0 }
  }
  let crc = 0xffffffff
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function makePngChunk(type, data) {
  const t = asciiBytes(type)
  const chunk = new Uint8Array(12 + data.length)
  writeUint32(chunk, 0, data.length)
  chunk.set(t, 4); chunk.set(data, 8)
  const crcIn = new Uint8Array(t.length + data.length); crcIn.set(t, 0); crcIn.set(data, t.length)
  writeUint32(chunk, 8 + data.length, crc32(crcIn))
  return chunk
}

/** Read a PNG's declared DPI from its pHYs chunk, or null. */
export function readPngDpi(buffer) {
  const b = new Uint8Array(buffer)
  if (!isPng(b)) return null
  let o = 8
  while (o + 12 <= b.length) {
    const len = readUint32(b, o), type = readAscii(b, o + 4, 4), at = o + 8
    if (type === 'pHYs' && len >= 9 && at + 9 <= b.length) {
      const x = readUint32(b, at), y = readUint32(b, at + 4), unit = b[at + 8]
      return (unit === 1 && x > 0 && y > 0) ? { x: x * 0.0254, y: y * 0.0254 } : null
    }
    o += 12 + len
  }
  return null
}

/** Stamp a PNG blob with a pHYs chunk so it prints at the given DPI. Returns a new blob. */
export async function addPngDpi(blob, dpi) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (!isPng(bytes)) return blob
  const ihdrLen = readUint32(bytes, 8)
  const insertAt = 8 + 12 + ihdrLen
  const ppm = Math.round(dpi / 0.0254)
  const data = new Uint8Array(9)
  writeUint32(data, 0, ppm); writeUint32(data, 4, ppm); data[8] = 1
  const chunk = makePngChunk('pHYs', data)
  const out = new Uint8Array(bytes.length + chunk.length)
  out.set(bytes.slice(0, insertAt), 0)
  out.set(chunk, insertAt)
  out.set(bytes.slice(insertAt), insertAt + chunk.length)
  return new Blob([out], { type: 'image/png' })
}

export const canvasToPngBlob = (canvas) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('PNG export failed')), 'image/png'))

/* ---------- trim + resize ---------- */

/**
 * Find the tight bounding box of the non-transparent pixels (alpha > threshold). Returns the crop
 * rect + source dims, or null if the image is fully transparent.
 */
export function analyzeTrim(img, threshold = 1) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, w, h); ctx.drawImage(img, 0, 0)
  const px = ctx.getImageData(0, 0, w, h).data
  const th = Math.max(0, Math.min(254, Number(threshold) || 1))
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    const row = y * w * 4
    for (let x = 0; x < w; x++) {
      if (px[row + x * 4 + 3] > th) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y }
    }
  }
  if (maxX < 0 || maxY < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, sourceW: w, sourceH: h }
}

/**
 * Resample the cropped art to an exact physical size. Returns { canvas, outW, outH }. Guards
 * against absurd output sizes. Caller stamps DPI via addPngDpi(await canvasToPngBlob(canvas), dpi).
 */
export function resizeToPrint(img, crop, { widthIn, heightIn, dpi = 300 }) {
  if (!crop) throw new Error('Trim the art first')
  const d = Math.max(72, Math.min(1200, Math.round(Number(dpi) || 300)))
  if (!(widthIn > 0) || !(heightIn > 0)) throw new Error('Enter a width and height in inches')
  const outW = Math.max(1, Math.round(widthIn * d)), outH = Math.max(1, Math.round(heightIn * d))
  if (outW > 12000 || outH > 12000 || outW * outH > 90_000_000) throw new Error('That output is too large — lower the size or DPI')
  const c = document.createElement('canvas'); c.width = outW; c.height = outH
  const ctx = c.getContext('2d')
  ctx.clearRect(0, 0, outW, outH)
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH)
  return { canvas: c, outW, outH, dpi: d }
}

/* ---------- print-quality check, upscaling, and gang-sheet layout ---------- */

/**
 * Is this art actually good enough to print at the requested size?
 *
 * The question every shop asks and most software answers too late. Effective DPI is the source
 * pixels divided by the printed inches — a 600px logo blown to 12" is 50 DPI and will look like
 * mud no matter what any "enhance" button claims. Thresholds follow what apparel decorators
 * actually accept: 300 is the spec, 200 is fine on fabric, under 150 is a reprint waiting to happen.
 */
export function printQuality(srcW, srcH, widthIn, heightIn) {
  if (!(widthIn > 0) || !(heightIn > 0)) return null
  const dpi = Math.floor(Math.min(srcW / widthIn, srcH / heightIn))
  const level = dpi >= 300 ? 'good' : dpi >= 200 ? 'ok' : dpi >= 150 ? 'warn' : 'bad'
  const label = {
    good: 'Sharp — full print quality',
    ok: 'Good for apparel — slightly under 300 DPI but prints clean on fabric',
    warn: 'Soft — usable on a large back print, not on a left chest',
    bad: 'Too low — this will print blurry. Ask for the original file.',
  }[level]
  return { dpi, level, label, ok: dpi >= 200 }
}

/** Largest size this art can print at while staying at or above a target DPI. */
export const maxPrintSize = (srcW, srcH, dpi = 300) => ({
  widthIn: Math.round((srcW / dpi) * 100) / 100,
  heightIn: Math.round((srcH / dpi) * 100) / 100,
})

/**
 * Upscale in repeated steps of at most 2×, rather than one enormous draw.
 *
 * A single drawImage to 4× resamples straight from the source and throws away detail; stepping
 * doubles the browser's smoothing over each pass and keeps noticeably cleaner edges. This is honest
 * interpolation — it cannot invent detail that was never captured, so printQuality() above still
 * governs whether the result is worth printing.
 */
export function upscale(img, crop, factor) {
  const f = Math.max(1, Math.min(8, Number(factor) || 2))
  const sx = crop?.x ?? 0, sy = crop?.y ?? 0
  const sw = crop?.w ?? img.naturalWidth, sh = crop?.h ?? img.naturalHeight
  const targetW = Math.round(sw * f), targetH = Math.round(sh * f)
  if (targetW * targetH > 90_000_000) throw new Error('That upscale is too large — lower the factor')

  let c = document.createElement('canvas')
  c.width = sw; c.height = sh
  let ctx = c.getContext('2d')
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)

  let curW = sw, curH = sh
  while (curW < targetW) {
    const nextW = Math.min(targetW, curW * 2), nextH = Math.min(targetH, curH * 2)
    const n = document.createElement('canvas')
    n.width = nextW; n.height = nextH
    const nctx = n.getContext('2d')
    nctx.imageSmoothingEnabled = true; nctx.imageSmoothingQuality = 'high'
    nctx.drawImage(c, 0, 0, curW, curH, 0, 0, nextW, nextH)
    c = n; curW = nextW; curH = nextH
  }
  return { canvas: c, outW: curW, outH: curH, factor: f }
}

/**
 * How a run of one design tiles onto a DTF roll, and what that length costs.
 *
 * Gang sheets are billed by the linear inch of roll consumed, so the useful answer is "how far down
 * the roll does this order push you" — not just a piece count. Pieces are nested across the roll
 * width first, then wrapped to a new row.
 */
export function gangSheetLayout({ pieceW, pieceH, qty, sheetWidth = 22, gap = 0.25 }) {
  const w = Number(pieceW) || 0, h = Number(pieceH) || 0, n = Math.max(0, Math.floor(Number(qty) || 0))
  const roll = Number(sheetWidth) || 22, g = Math.max(0, Number(gap) || 0)
  if (!(w > 0) || !(h > 0) || !n) return null
  if (w > roll) return { error: `A ${w}" wide piece doesn't fit on a ${roll}" roll — rotate it or size it down.` }
  const perRow = Math.max(1, Math.floor((roll + g) / (w + g)))
  const rows = Math.ceil(n / perRow)
  const lengthIn = Math.round((rows * (h + g) - g) * 100) / 100
  const usedArea = n * w * h
  const sheetArea = roll * lengthIn
  return {
    perRow, rows, lengthIn, perRowGap: g, sheetWidth: roll,
    lengthFt: Math.round((lengthIn / 12) * 100) / 100,
    // What fraction of the roll you actually print on — the number that decides whether it's worth
    // ganging more designs onto the same sheet.
    efficiency: sheetArea > 0 ? Math.round((usedArea / sheetArea) * 100) : 0,
    slotsUnused: perRow * rows - n,
  }
}

/** Gang-sheet price from the shop's own linear-inch rate and order minimum. */
export const gangSheetPrice = (lengthIn, pricePerInch = 0.95, minCharge = 10) =>
  Math.round(Math.max(Number(minCharge) || 0, (Number(lengthIn) || 0) * (Number(pricePerInch) || 0)) * 100) / 100

/**
 * The sheet sizes DTF is actually sold in. Suppliers quote a fixed roll width (22" is the common
 * one) and a set of lengths, so a shop thinks in "a 22×60 sheet", not in linear inches. Offering the
 * standard ladder lets the planner answer the real question: which sheet do I need to buy?
 */
export const SHEET_SIZES = [
  { label: '22" × 12"', w: 22, h: 12 },
  { label: '22" × 24"', w: 22, h: 24 },
  { label: '22" × 36"', w: 22, h: 36 },
  { label: '22" × 60"', w: 22, h: 60 },
  { label: '22" × 120"', w: 22, h: 120 },
]

/** The smallest standard sheet that fits a required length, or null if it needs a custom run. */
export const fitSheet = (lengthIn, sizes = SHEET_SIZES) =>
  sizes.find((s) => s.h >= lengthIn) || null

/**
 * Load an image and resolve once it can actually be drawn.
 *
 * Uses onload rather than img.decode(): decode() is the newer API but on a detached <img> in Chrome
 * it can never settle — neither resolving nor rejecting — which left the art tools hanging silently
 * with no error and no art. onload/onerror always fire, and a timeout guarantees the caller is never
 * stuck on a file the browser refuses outright.
 */
export function loadImage(src, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    let done = false
    const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(t); fn(arg) } }
    const t = setTimeout(() => finish(reject, new Error('Timed out reading that image')), timeoutMs)
    img.onload = () => finish(resolve, img)
    img.onerror = () => finish(reject, new Error('Could not read that image'))
    img.src = src
  })
}
