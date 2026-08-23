/**
 * Code 128 (subset B) rendered as a self-contained SVG — no deps, no canvas.
 *
 * Used on work tickets so a phone camera can pull up / advance the job (BarcodeDetector reads
 * code_128 natively on Android Chrome; iOS falls back to typing the job number, which is printed
 * directly beneath the bars). Code 128 over QR because it's trivial to generate correctly,
 * scans fast at print size, and the payload is a short job number, not a URL.
 */

// Standard Code 128 bar/space width patterns, values 0-105 + stop (106). Each digit is a module
// width; entries alternate bar,space,bar,space,bar,space. The stop pattern has 7 elements.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]
const START_B = 104
const STOP = 106

/** Code-B symbol values for a string (printable ASCII 32-126 only). */
export function code128Values(text) {
  const t = String(text)
  const values = [START_B]
  for (const ch of t) {
    const code = ch.charCodeAt(0)
    if (code < 32 || code > 126) throw new Error(`Code 128B cannot encode ${JSON.stringify(ch)}`)
    values.push(code - 32)
  }
  let checksum = START_B
  for (let i = 1; i < values.length; i++) checksum += values[i] * i
  values.push(checksum % 103)
  values.push(STOP)
  return values
}

/** Render as an SVG string. Height/module width in px; quiet zone per spec (10 modules). */
export function code128Svg(text, { height = 56, module = 2, quiet = 10 } = {}) {
  const values = code128Values(text)
  let totalModules = quiet * 2
  for (const v of values) for (const d of PATTERNS[v]) totalModules += Number(d)
  const w = totalModules * module
  let x = quiet * module
  const rects = []
  for (const v of values) {
    const pat = PATTERNS[v]
    for (let i = 0; i < pat.length; i++) {
      const wid = Number(pat[i]) * module
      if (i % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${wid}" height="${height}"/>`)
      x += wid
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}" role="img" aria-label="${String(text).replace(/[&<>"]/g, '')}"><g fill="#111">${rects.join('')}</g></svg>`
}
