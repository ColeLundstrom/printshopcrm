/**
 * QR codes drawn from the `qrcode` module's matrix, synchronously, as vector shapes — no image
 * embedding (the PDF writer has no image support) and no async encode on the request path.
 */
import QRCode from 'qrcode'

/**
 * Dark-module runs of a QR matrix: [{ row, col, len }]. Adjacent dark modules in a row merge into
 * one rectangle, which keeps a typical pay-link code to a few hundred drawing ops.
 */
export function qrRuns(text, { errorCorrectionLevel = 'M' } = {}) {
  const { modules } = QRCode.create(String(text), { errorCorrectionLevel })
  const n = modules.size, runs = []
  for (let r = 0; r < n; r++) {
    let c = 0
    while (c < n) {
      if (!modules.get(r, c)) { c++; continue }
      const start = c
      while (c < n && modules.get(r, c)) c++
      runs.push({ row: r, col: start, len: c - start })
    }
  }
  return { size: n, runs }
}

/**
 * PDF content-stream operations drawing the code as filled rectangles. (x, top) is the top-left
 * corner in top-down page coordinates; `pageH` flips it to PDF space. The caller keeps a quiet zone
 * of at least four modules clear around it (the page background is white).
 */
export function qrPdfOps(text, x, top, width, pageH) {
  const { size, runs } = qrRuns(text)
  const m = width / size
  const ops = ['% qr-to-pay', '0 0 0 rg']
  for (const { row, col, len } of runs) {
    const px = x + col * m, py = pageH - (top + (row + 1) * m)
    ops.push(`${px.toFixed(3)} ${py.toFixed(3)} ${(len * m).toFixed(3)} ${m.toFixed(3)} re`)
  }
  ops.push('f')
  return ops
}

/** A self-contained inline SVG of the code (one path), with a four-module quiet zone. */
export function qrSvg(text, { size = 96, label = 'QR code' } = {}) {
  const { size: n, runs } = qrRuns(text)
  const q = 4, total = n + q * 2
  const d = runs.map(({ row, col, len }) => `M${col + q} ${row + q}h${len}v1h-${len}z`).join('')
  const safe = String(label).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" role="img" aria-label="${safe}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}
