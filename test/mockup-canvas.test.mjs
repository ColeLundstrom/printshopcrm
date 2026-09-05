import test from 'node:test'
import assert from 'node:assert/strict'
import { outputSize, validateInputHeader, decodeRaster, makeRecipe, paintMockup, movePlacement, artworkClipped, exportProof, newRequestId, makeSaveReceipt, receiptFormData } from '../public/js/shared/mockup-canvas.js'

const photoHeader = { orientedWidth: 3000, orientedHeight: 2000, animated: false }
const placement = { x: .5, y: .4, width: .3, rotation: 90 }

test('output fits bounded photo aspect; placement and physical notes reject invalid geometry', () => {
  assert.deepEqual(outputSize(3000, 2000), { width: 2000, height: 1333 })
  assert.deepEqual(outputSize(100, 200), { width: 100, height: 200 })
  assert.deepEqual(outputSize(1, 4096), { width: 1, height: 2000 })
  assert.throws(() => outputSize(10000, 200), /dimensions/)
  assert.throws(() => outputSize(NaN, 200), /dimensions/)
  const recipe = makeRecipe(photoHeader, placement, { width: 12, height: 14, units: 'in' })
  assert.equal(recipe.sizing_mode, 'visual')
  assert.deepEqual(recipe.canvas, { width: 2000, height: 1333 })
  assert.deepEqual(recipe.requested_print, { width: 12, height: 14, units: 'in' })
  assert.throws(() => makeRecipe(photoHeader, { ...placement, x: 1.01 }), /ranges/)
  assert.throws(() => makeRecipe(photoHeader, { ...placement, width: 0 }), /ranges/)
  assert.throws(() => makeRecipe(photoHeader, placement, { width: 12, height: 0, units: 'in' }), /both/)
  assert.throws(() => makeRecipe(photoHeader, placement, { width: 12, height: 14, units: 'px' }), /both/)
})

test('decode allocation is refused before opening animated, large or combined-over-budget inputs', () => {
  assert.throws(() => validateInputHeader({ ...photoHeader, animated: true }), /Animated/)
  assert.throws(() => validateInputHeader({ ...photoHeader, orientedWidth: 4097 }), /4096/)
  assert.throws(() => validateInputHeader(photoHeader, { orientedWidth: 2000, orientedHeight: 2000 }), /8 million/)
  assert.equal(validateInputHeader(photoHeader, { orientedWidth: 1000, orientedHeight: 2000 }), photoHeader)
})

test('browser decode explicitly honors EXIF and closes inconsistent decode results', async () => {
  const header = { orientedWidth: 600, orientedHeight: 800 }
  const source = new Blob(['original']), bitmap = { width: 600, height: 800 }
  let options
  const decoded = await decodeRaster(source, header, async (file, opts) => { assert.equal(file, source); options = opts; return bitmap })
  assert.equal(decoded, bitmap); assert.equal(options.imageOrientation, 'from-image')
  let closed = false
  await assert.rejects(decodeRaster(source, header, async () => ({ width: 800, height: 600, close() { closed = true } })), /orientation/)
  assert.equal(closed, true)
  await assert.rejects(decodeRaster(source, header, null), /ImageBitmap/)
})

test('renderer draws original bitmaps with locked aspect and center rotation; no generated art or guide in export', () => {
  const calls = []
  const context = Object.fromEntries(['setTransform', 'clearRect', 'drawImage', 'save', 'translate', 'rotate', 'restore'].map(method => [method, (...args) => calls.push([method, ...args])]))
  const photo = { width: 1000, height: 1000 }, art = { width: 400, height: 200 }
  const recipe = makeRecipe({ orientedWidth: 1000, orientedHeight: 1000 }, placement)
  paintMockup(context, photo, art, recipe)
  assert.deepEqual(calls, [
    ['setTransform', 1, 0, 0, 1, 0, 0], ['clearRect', 0, 0, 1000, 1000], ['drawImage', photo, 0, 0, 1000, 1000],
    ['save'], ['translate', 500, 400], ['rotate', Math.PI / 2], ['drawImage', art, -150, -75, 300, 150], ['restore'],
  ])
  assert.equal(context.globalAlpha, 1); assert.equal(context.globalCompositeOperation, 'source-over')
})

test('keyboard movement stays bounded and clipping accounts for rotation', () => {
  assert.equal(movePlacement({ ...placement, x: 0 }, 'ArrowLeft').x, 0)
  assert.equal(movePlacement(placement, 'ArrowRight', true).x, .55)
  assert.equal(movePlacement(placement, 'Enter'), null)
  const canvas = { width: 1000, height: 1000 }, art = { width: 1000, height: 100 }
  assert.equal(artworkClipped(canvas, art, { x: .5, y: .1, width: .5, rotation: 0 }), false)
  assert.equal(artworkClipped(canvas, art, { x: .5, y: .1, width: .5, rotation: 90 }), true)
})

test('uncertain retry retains byte-identical originals, PNG, metadata and request ID', async () => {
  const photo = new File([new Uint8Array([0, 255, 2, 3])], 'photo.png', { type: 'image/png' })
  const artwork = new File([new Uint8Array([4, 5, 128, 7])], 'original.png', { type: 'image/png' })
  const proof = new Blob(['same exported PNG'], { type: 'image/png' })
  const recipe = makeRecipe(photoHeader, placement)
  const receipt = makeSaveReceipt({ revision: 7, photo, artwork, proof, recipe, mediaTicket: 'verified-photo-ticket' }, 'fixture-request')
  recipe.placement.width = .9
  const first = receiptFormData(receipt), retry = receiptFormData(receipt)
  for (const key of ['photo', 'artwork', 'proof']) {
    assert.deepEqual(new Uint8Array(await first.get(key).arrayBuffer()), new Uint8Array(await retry.get(key).arrayBuffer()))
    assert.equal(first.get(key).name, retry.get(key).name)
  }
  for (const key of ['revision', 'request_id', 'recipe', 'media_ticket']) assert.equal(first.get(key), retry.get(key))
  assert.equal(JSON.parse(first.get('recipe')).placement.width, .3)
  assert.equal(first.get('artwork').name, 'original.png')
  assert.equal(first.get('proof').name, 'appearance-mockup.png')
  const changed = makeSaveReceipt({ revision: 8, photo, artwork, proof, recipe }, 'changed-request')
  assert.notEqual(changed.requestId, receipt.requestId)
  assert.equal(receiptFormData(changed).has('media_ticket'), false)
})

test('PNG export errors are actionable; unsupported or excessive buffers cannot be saved', async () => {
  await assert.rejects(exportProof({ width: 4000, height: 4000 }), /limit/)
  await assert.rejects(exportProof({ width: 100, height: 100, toBlob(callback) { callback(null) } }), /export a PNG/)
  await assert.rejects(exportProof({ width: 100, height: 100, toBlob() { throw new Error('tainted') } }), /safely/)
  const png = new Blob(['png'], { type: 'image/png' })
  assert.equal(await exportProof({ width: 100, height: 100, toBlob(callback, type) { assert.equal(type, 'image/png'); callback(png) } }), png)
})

test('local HTTP still creates unique version-four IDs without randomUUID', () => {
  const first = newRequestId({ getRandomValues: bytes => { bytes.fill(0); return bytes } })
  assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.throws(() => newRequestId({}), /safe save receipt/)
})
