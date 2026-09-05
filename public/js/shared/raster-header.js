/** Shared browser/server inspection. No image decode, decompression, filesystem or Node APIs.
 * PNG/WebP require the complete size-bounded file because EXIF can follow pixel chunks.
 * JPEG needs only the first 256 KiB, through its first scan header. At most 256 KiB of
 * non-pixel headers/metadata and 4096 chunks/segments are inspected in any format.
 * This validates container metadata, not compressed pixels or production suitability.
 */
export const RASTER_HEADER_BYTES = 256 * 1024
export const MOCKUP_LIMITS = Object.freeze({
  inputBytes: 10 * 1024 * 1024, inputEdge: 4096, combinedPixels: 8000000,
  outputBytes: 16 * 1024 * 1024, outputEdge: 2000, outputPixels: 4000000,
})
const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_raster_header', status: 400, expose: true }) }
const malformed = () => fail('This image has incomplete or invalid headers. Export a new still PNG, JPEG or WebP and try again.')
const tooMuch = () => fail('This image has too much metadata to inspect safely. Export a new still PNG, JPEG or WebP and try again.')
const ascii = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n))

function exifOrientation(bytes) {
  let b = bytes
  if (ascii(b, 0, 6) === 'Exif\0\0') b = b.subarray(6)
  if (b.length < 8 || b.length > RASTER_HEADER_BYTES) malformed()
  const order = ascii(b, 0, 2), little = order === 'II'
  if (!little && order !== 'MM') malformed()
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (d.getUint16(2, little) !== 42) malformed()
  const start = d.getUint32(4, little)
  if (start < 8 || start + 2 > b.length) malformed()
  const count = d.getUint16(start, little)
  if (count > 1024 || start + 2 + count * 12 + 4 > b.length) malformed()
  let orientation = 1, found = false
  for (let p = start + 2; p < start + 2 + count * 12; p += 12) {
    if (d.getUint16(p, little) !== 0x112) continue
    if (found || d.getUint16(p + 2, little) !== 3 || d.getUint32(p + 4, little) !== 1) malformed()
    found = true
    orientation = d.getUint16(p + 8, little)
    if (orientation < 1 || orientation > 8) malformed()
  }
  return orientation
}

function result(format, width, height, orientation = 1, animated = false) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) malformed()
  if (width > MOCKUP_LIMITS.inputEdge || height > MOCKUP_LIMITS.inputEdge || width * height > MOCKUP_LIMITS.combinedPixels)
    fail('Resize this image before uploading: at most 4096 pixels per edge and 8 million pixels.')
  return { format, mime: `image/${format}`, width, height, orientation,
    orientedWidth: orientation >= 5 ? height : width, orientedHeight: orientation >= 5 ? width : height, animated }
}

function png(b, d) {
  let p = 8, chunks = 0, metadata = 8, width, height, orientation = 1
  let seenData = false, endedData = false, seenExif = false, animated = false
  while (p < b.length) {
    if (++chunks > 4096) tooMuch()
    if (p + 12 > b.length) malformed()
    const size = d.getUint32(p), type = ascii(b, p + 4, 4), body = p + 8, end = body + size
    if (!/^[A-Za-z]{4}$/.test(type) || size > 0x7fffffff || end + 4 > b.length) malformed()
    metadata += 12 + (['IDAT', 'fdAT'].includes(type) ? 0 : size)
    if (metadata > RASTER_HEADER_BYTES) tooMuch()
    if (chunks === 1 && type !== 'IHDR') malformed()
    if (type === 'IHDR') {
      if (chunks !== 1 || size !== 13) malformed()
      width = d.getUint32(body); height = d.getUint32(body + 4)
      const depth = b[body + 8], color = b[body + 9]
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!depths[color]?.includes(depth) || b[body + 10] || b[body + 11] || b[body + 12] > 1) malformed()
      result('png', width, height)
    } else if (type === 'IDAT') {
      if (endedData) malformed()
      seenData = true
    } else {
      if (seenData) endedData = true
      if (type === 'eXIf') {
        if (seenExif) malformed()
        seenExif = true; orientation = exifOrientation(b.subarray(body, end))
      } else if (type === 'acTL') {
        if (animated || seenData || size !== 8 || d.getUint32(body) === 0) malformed()
        animated = true
      } else if (type === 'fcTL' || type === 'fdAT') {
        if (!animated || size < (type === 'fcTL' ? 26 : 4)) malformed()
      } else if (type === 'IEND') {
        if (size !== 0 || !seenData || end + 4 !== b.length) malformed()
        return result('png', width, height, orientation, animated)
      } else if (type[0] === type[0].toUpperCase() && type !== 'PLTE') malformed()
    }
    p = end + 4
  }
  malformed()
}

function jpeg(b, d) {
  let p = 2, segments = 0, width, height, orientation = 1, seenExif = false
  const limit = Math.min(b.length, RASTER_HEADER_BYTES)
  while (p < limit) {
    if (++segments > 4096) tooMuch()
    if (b[p++] !== 0xff) malformed()
    while (p < limit && b[p] === 0xff) p++
    if (p >= limit) break
    const marker = b[p++]
    if (marker === 0x01) continue
    if (marker === 0 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) malformed()
    if (p + 2 > limit) break
    const size = d.getUint16(p), body = p + 2, end = p + size
    if (size < 2) malformed()
    if (end > limit) { if (end > RASTER_HEADER_BYTES) tooMuch(); malformed() }
    if (marker === 0xe1 && ascii(b, body, 6) === 'Exif\0\0') {
      if (seenExif) malformed()
      seenExif = true; orientation = exifOrientation(b.subarray(body, end))
    }
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (width !== undefined || size < 8 || b[body] !== 8) malformed()
      const components = b[body + 5]
      if (![1, 3, 4].includes(components) || size !== 8 + components * 3) malformed()
      height = d.getUint16(body + 1); width = d.getUint16(body + 3)
      result('jpeg', width, height)
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      fail('This JPEG encoding is not supported. Export a standard still PNG or JPEG and try again.')
    }
    if (marker === 0xda) {
      const components = b[body]
      if (!width || size < 6 || components < 1 || components > 4 || size !== 6 + components * 2) malformed()
      return result('jpeg', width, height, orientation)
    }
    p = end
  }
  if (b.length >= RASTER_HEADER_BYTES) tooMuch()
  malformed()
}

function webp(b, d) {
  if (b.length < 20 || d.getUint32(4, true) + 8 !== b.length) malformed()
  let p = 12, chunks = 0, metadata = 12, width, height, imageWidth, imageHeight
  let flags = 0, extended = false, animated = false, seenExif = false, orientation = 1, images = 0
  const u24 = p => b[p] + b[p + 1] * 256 + b[p + 2] * 65536
  while (p < b.length) {
    if (++chunks > 4096) tooMuch()
    if (p + 8 > b.length) malformed()
    const type = ascii(b, p, 4), size = d.getUint32(p + 4, true), body = p + 8, end = body + size
    const next = end + size % 2
    if (next > b.length) malformed()
    metadata += 8 + (['VP8 ', 'VP8L', 'ALPH', 'ANMF'].includes(type) ? 0 : size)
    if (metadata > RASTER_HEADER_BYTES) tooMuch()
    if (type === 'VP8X') {
      if (chunks !== 1 || extended || size !== 10) malformed()
      extended = true; flags = b[body]
      if ((flags & 0xc1) || b[body + 1] || b[body + 2] || b[body + 3]) malformed()
      animated = Boolean(flags & 2)
      width = u24(body + 4) + 1; height = u24(body + 7) + 1
      result('webp', width, height)
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (++images !== 1 || animated) malformed()
      if (type === 'VP8 ') {
        if (size < 10 || (b[body] & 1) || ascii(b, body + 3, 3) !== '\x9d\x01\x2a') malformed()
        imageWidth = d.getUint16(body + 6, true) & 0x3fff; imageHeight = d.getUint16(body + 8, true) & 0x3fff
      } else {
        if (size < 5 || b[body] !== 0x2f) malformed()
        const bits = d.getUint32(body + 1, true)
        if (bits >>> 29) malformed()
        imageWidth = (bits & 0x3fff) + 1; imageHeight = ((bits >>> 14) & 0x3fff) + 1
      }
      result('webp', imageWidth, imageHeight)
    } else if (type === 'EXIF') {
      if (!extended || !(flags & 8) || seenExif) malformed()
      seenExif = true; orientation = exifOrientation(b.subarray(body, end))
    } else if (type === 'ANIM' || type === 'ANMF') {
      if (!animated || !extended || size < (type === 'ANIM' ? 6 : 16)) malformed()
      if (type === 'ANMF') images++
    } else if (!extended) malformed()
    p = next
  }
  if (!images || (extended && Boolean(flags & 8) !== seenExif)) malformed()
  if (!extended) { width = imageWidth; height = imageHeight }
  if (!animated && (width !== imageWidth || height !== imageHeight)) malformed()
  return result('webp', width, height, orientation, animated)
}

export function readRasterHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) malformed()
  if (bytes.length > MOCKUP_LIMITS.outputBytes) fail('This image exceeds the 16 MiB inspection limit.')
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return png(bytes, d)
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes, d)
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webp(bytes, d)
  fail('Choose a still PNG, JPEG or WebP image. Other file types cannot be used in this composer.')
}
