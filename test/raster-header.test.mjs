import test from 'node:test'
import assert from 'node:assert/strict'
import { readRasterHeader, MOCKUP_LIMITS, RASTER_HEADER_BYTES } from '../public/js/shared/raster-header.js'

const be32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const le32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function exif(orientation, little = true) {
  const b = Buffer.alloc(26), d = new DataView(b.buffer, b.byteOffset, b.length)
  b.write(little ? 'II' : 'MM'); d.setUint16(2, 42, little); d.setUint32(4, 8, little)
  d.setUint16(8, 1, little); d.setUint16(10, 0x112, little); d.setUint16(12, 3, little)
  d.setUint32(14, 1, little); d.setUint16(18, orientation, little)
  return b
}
const chunk = (type, bytes) => Buffer.concat([be32(bytes.length), Buffer.from(type), bytes, Buffer.alloc(4)])
function png(width = 640, height = 480, extra = [], data = Buffer.from([0])) {
  const ihdr = Buffer.concat([be32(width), be32(height), Buffer.from([8, 6, 0, 0, 0])])
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', ihdr), chunk('IDAT', data), ...extra, chunk('IEND', Buffer.alloc(0))])
}
const jpgSegment = (marker, bytes) => { const n = Buffer.alloc(2); n.writeUInt16BE(bytes.length + 2); return Buffer.concat([Buffer.from([255, marker]), n, bytes]) }
function jpeg(orientation = 1, little = true, extra = []) {
  const sof = Buffer.from([8, 1, 224, 2, 128, 1, 1, 17, 0])
  return Buffer.concat([Buffer.from([255, 216]), ...extra, jpgSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), exif(orientation, little)])),
    jpgSegment(0xc0, sof), jpgSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([255, 217])])
}
const riffChunk = (type, bytes) => Buffer.concat([Buffer.from(type), le32(bytes.length), bytes, Buffer.alloc(bytes.length % 2)])
function webp(orientation = null, animation = false, dataSize = 10) {
  const x = Buffer.alloc(10); x[0] = (orientation === null ? 0 : 8) | (animation ? 2 : 0)
  x.writeUIntLE(639, 4, 3); x.writeUIntLE(479, 7, 3)
  const image = Buffer.alloc(dataSize); image.set([0, 0, 0, 157, 1, 42, 128, 2, 224, 1])
  const body = Buffer.concat([Buffer.from('WEBP'), ...(orientation !== null || animation ? [riffChunk('VP8X', x)] : []),
    ...(animation ? [riffChunk('ANIM', Buffer.alloc(6)), riffChunk('ANMF', Buffer.alloc(16))] : [riffChunk('VP8 ', image)]),
    ...(orientation !== null ? [riffChunk('EXIF', exif(orientation))] : [])])
  return Buffer.concat([Buffer.from('RIFF'), le32(body.length), body])
}

test('still PNG/JPEG/WebP headers expose exact dimensions without decoding pixel data', () => {
  assert.deepEqual(MOCKUP_LIMITS, { inputBytes: 10485760, inputEdge: 4096, combinedPixels: 8000000, outputBytes: 16777216, outputEdge: 2000, outputPixels: 4000000 })
  for (const [format, bytes] of [['png', png()], ['jpeg', jpeg()], ['webp', webp()]]) {
    const wrapped = Buffer.concat([Buffer.alloc(7), bytes, Buffer.alloc(3)]).subarray(7, 7 + bytes.length)
    assert.deepEqual(readRasterHeader(wrapped), { format, mime: `image/${format}`, width: 640, height: 480,
      orientation: 1, orientedWidth: 640, orientedHeight: 480, animated: false })
  }
  const bits = le32(639 | (479 << 14))
  const payload = Buffer.concat([Buffer.from('WEBP'), riffChunk('VP8L', Buffer.concat([Buffer.from([47]), bits]))])
  assert.equal(readRasterHeader(Buffer.concat([Buffer.from('RIFF'), le32(payload.length), payload])).width, 640)
})

test('all EXIF orientations, including mirrors and late PNG/WebP metadata, are explicit', () => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    for (const bytes of [jpeg(orientation), jpeg(orientation, false), png(640, 480, [chunk('eXIf', exif(orientation, false))]), webp(orientation)]) {
      const h = readRasterHeader(bytes)
      assert.equal(h.orientation, orientation)
      assert.equal(h.orientedWidth, orientation >= 5 ? 480 : 640)
      assert.equal(h.orientedHeight, orientation >= 5 ? 640 : 480)
    }
  }
  for (const orientation of [0, 9]) for (const bytes of [jpeg(orientation), png(640, 480, [chunk('eXIf', exif(orientation))]), webp(orientation)])
    assert.throws(() => readRasterHeader(bytes), /invalid headers/)
  const overflow = exif(1); overflow.writeUInt32LE(0xfffffff0, 4)
  assert.throws(() => readRasterHeader(png(640, 480, [chunk('eXIf', overflow)])), /invalid headers/)
  assert.throws(() => readRasterHeader(png(640, 480, [chunk('eXIf', exif(1)), chunk('eXIf', exif(1))])), /invalid headers/)
  assert.throws(() => readRasterHeader(jpeg(1, true, [jpgSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), exif(1)]))])), /invalid headers/)
})

test('animation is detected before the caller decodes an image and malformed flags are rejected', () => {
  const base = png(), control = chunk('acTL', Buffer.concat([be32(2), be32(0)]))
  const apng = Buffer.concat([base.subarray(0, 33), control, base.subarray(33)])
  assert.equal(readRasterHeader(apng).animated, true)
  assert.equal(readRasterHeader(webp(null, true)).animated, true)
  assert.throws(() => readRasterHeader(png(640, 480, [control])), /invalid headers/)
  assert.throws(() => readRasterHeader(png(640, 480, [chunk('fcTL', Buffer.alloc(26))])), /invalid headers/)
  const bad = webp(1); bad[20] |= 0x80
  assert.throws(() => readRasterHeader(bad), /invalid headers/)
})

test('enormous compressed image dimensions and forged chunk lengths fail without allocation or inflation', () => {
  for (const [w, h] of [[0, 20], [0xffffffff, 20], [4097, 1], [4096, 4096]])
    assert.throws(() => readRasterHeader(png(w, h)), error => error.code === 'invalid_raster_header' && error.status === 400 && error.expose)
  const hugeWebp = webp(1); hugeWebp.writeUIntLE(0xffffff, 24, 3)
  assert.throws(() => readRasterHeader(hugeWebp), /Resize this image/)
  const badPng = png(); badPng.writeUInt32BE(0x7fffffff, 33)
  assert.throws(() => readRasterHeader(badPng), /invalid headers/)
  const badWebp = webp(); badWebp.writeUInt32LE(0xfffffffe, 16)
  assert.throws(() => readRasterHeader(badWebp), /invalid headers/)
  for (const bytes of [new Uint8Array(), new Uint8Array(5), Buffer.from('GIF89a'), png().subarray(0, 40), jpeg().subarray(0, 20), webp().subarray(0, 20)])
    assert.throws(() => readRasterHeader(bytes), error => error.code === 'invalid_raster_header')
})

test('metadata and header budgets are bounded while compressed payload can be skipped to late EXIF', () => {
  assert.equal(RASTER_HEADER_BYTES, 262144)
  assert.equal(readRasterHeader(png(640, 480, [chunk('eXIf', exif(6))], Buffer.alloc(RASTER_HEADER_BYTES * 2))).orientation, 6)
  assert.equal(readRasterHeader(webp(6, false, RASTER_HEADER_BYTES * 2)).orientation, 6)
  assert.throws(() => readRasterHeader(png(640, 480, [chunk('iTXt', Buffer.alloc(RASTER_HEADER_BYTES))])), /too much metadata/)
  assert.throws(() => readRasterHeader(jpeg(1, true, Array.from({ length: 5 }, () => jpgSegment(0xe0, Buffer.alloc(60000))))), /too much metadata/)
  const jpegWithPixels = Buffer.concat([jpeg(6), Buffer.alloc(RASTER_HEADER_BYTES * 2)])
  assert.equal(readRasterHeader(jpegWithPixels.subarray(0, RASTER_HEADER_BYTES)).orientation, 6)
  assert.throws(() => readRasterHeader(png(640, 480, Array.from({ length: 4096 }, () => chunk('tEXt', Buffer.alloc(0))))), /too much metadata/)
  assert.throws(() => readRasterHeader(new Uint8Array(MOCKUP_LIMITS.outputBytes + 1)), /16 MiB/)
})
