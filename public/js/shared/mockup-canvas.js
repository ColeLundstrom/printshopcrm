/* Device-only appearance composer. Originals are never painted into or rewritten. */
import { MOCKUP_LIMITS, readRasterHeader } from './raster-header.js'

export const INITIAL_PLACEMENT = Object.freeze({ x: 0.5, y: 0.4, width: 0.3, rotation: 0 })
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function outputSize(width, height) {
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= MOCKUP_LIMITS.inputEdge)) throw new Error('The photo dimensions are not supported.')
  const scale = Math.min(1, MOCKUP_LIMITS.outputEdge / Math.max(width, height))
  const size = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
  if (size.width * size.height > MOCKUP_LIMITS.outputPixels) throw new Error('The preview would be too large. Use a smaller photo.')
  return size
}

export function validateInputHeader(header, otherHeader = null) {
  const { orientedWidth: width, orientedHeight: height } = header
  if (header.animated) throw new Error('Animated images are not supported. Export one still image as PNG, JPEG or WebP.')
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= MOCKUP_LIMITS.inputEdge)) throw new Error('Each image must be at most 4096 pixels on its longest edge. Resize a copy before uploading.')
  const otherPixels = otherHeader ? otherHeader.orientedWidth * otherHeader.orientedHeight : 0
  if (width * height + otherPixels > MOCKUP_LIMITS.combinedPixels) throw new Error('The photo and artwork together exceed 8 million pixels. Resize a copy of one image before uploading.')
  return header
}

/** Validate bytes before the browser is allowed to allocate decoded pixel buffers. */
export async function inspectRaster(file, otherHeader = null) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1) throw new Error('Choose a PNG, JPEG or WebP file.')
  if (file.size > MOCKUP_LIMITS.inputBytes) throw new Error('Each image must be 10 MiB or smaller. Export a smaller copy before uploading.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const header = readRasterHeader(bytes)
  const extension = String(file.name || '').split('.').pop().toLowerCase()
  const extensions = { png: ['png'], jpeg: ['jpg', 'jpeg'], webp: ['webp'] }
  if (!extensions[header.format]?.includes(extension)) throw new Error(`This file needs the matching ${header.format === 'jpeg' ? '.jpg or .jpeg' : `.${header.format}`} extension. Export or rename a copy, then choose it again.`)
  return validateInputHeader(header, otherHeader)
}

export async function decodeRaster(file, header, decode = globalThis.createImageBitmap) {
  if (typeof decode !== 'function') throw new Error('This browser cannot safely open these images. Use a current browser with ImageBitmap support.')
  let bitmap
  try { bitmap = await decode(file, { imageOrientation: 'from-image', premultiplyAlpha: 'default', colorSpaceConversion: 'default' }) }
  catch { throw new Error('The browser could not open this image. Export a still PNG, JPEG or WebP copy and try again.') }
  if (bitmap.width !== header.orientedWidth || bitmap.height !== header.orientedHeight) {
    bitmap.close?.()
    throw new Error('The browser read this image’s orientation differently. Export an upright PNG copy and try again.')
  }
  return bitmap
}

export function makeRecipe(photoHeader, placement, requestedPrint = null) {
  const p = { ...placement }
  if (!['x', 'y', 'width', 'rotation'].every(key => Number.isFinite(p[key])) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1 || p.width < .01 || p.width > 2 || p.rotation < -180 || p.rotation > 180) throw new Error('Use placement values within the ranges shown.')
  const recipe = { version: 1, renderer: 'browser-canvas-v1', sizing_mode: 'visual', canvas: outputSize(photoHeader.orientedWidth, photoHeader.orientedHeight), placement: p }
  if (requestedPrint) {
    const { width, height, units } = requestedPrint
    if (![width, height].every(n => Number.isFinite(n) && n > 0) || !['in', 'mm', 'cm'].includes(units)) throw new Error('Enter both requested print dimensions as positive numbers, or leave both blank.')
    recipe.requested_print = { width, height, units }
  }
  return recipe
}

/** Canvas coordinates use the photo's oriented dimensions; art aspect stays locked. */
export function paintMockup(context, photo, artwork, recipe) {
  const { width, height } = recipe.canvas
  const p = recipe.placement
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, width, height)
  context.globalAlpha = 1
  context.globalCompositeOperation = 'source-over'
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(photo, 0, 0, width, height)
  if (!artwork) return
  const artWidth = width * p.width
  const artHeight = artWidth * artwork.height / artwork.width
  context.save()
  context.translate(p.x * width, p.y * height)
  context.rotate(p.rotation * Math.PI / 180)
  context.drawImage(artwork, -artWidth / 2, -artHeight / 2, artWidth, artHeight)
  context.restore()
}

export function movePlacement(placement, key, shiftKey = false) {
  const step = shiftKey ? .05 : .005
  const next = { ...placement }
  if (key === 'ArrowLeft') next.x = clamp(next.x - step, 0, 1)
  else if (key === 'ArrowRight') next.x = clamp(next.x + step, 0, 1)
  else if (key === 'ArrowUp') next.y = clamp(next.y - step, 0, 1)
  else if (key === 'ArrowDown') next.y = clamp(next.y + step, 0, 1)
  else return null
  return next
}

export function artworkClipped(canvas, artwork, placement) {
  if (!artwork) return false
  const halfWidth = canvas.width * placement.width / 2
  const halfHeight = halfWidth * artwork.height / artwork.width
  const angle = placement.rotation * Math.PI / 180
  const extentX = Math.abs(Math.cos(angle)) * halfWidth + Math.abs(Math.sin(angle)) * halfHeight
  const extentY = Math.abs(Math.sin(angle)) * halfWidth + Math.abs(Math.cos(angle)) * halfHeight
  const x = canvas.width * placement.x, y = canvas.height * placement.y
  return x - extentX < 0 || x + extentX > canvas.width || y - extentY < 0 || y + extentY > canvas.height
}

export function exportProof(canvas) {
  if (canvas.width > MOCKUP_LIMITS.outputEdge || canvas.height > MOCKUP_LIMITS.outputEdge || canvas.width * canvas.height > MOCKUP_LIMITS.outputPixels) return Promise.reject(new Error('The proof exceeds the export size limit.'))
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(blob => {
        if (!blob || blob.type !== 'image/png') return reject(new Error('The browser could not export a PNG. Your draft is still here.'))
        if (blob.size > MOCKUP_LIMITS.outputBytes) return reject(new Error('The exported proof is larger than 16 MiB. Use smaller images.'))
        resolve(blob)
      }, 'image/png')
    } catch { reject(new Error('This image could not be exported safely. Try a shop-uploaded photo.')) }
  })
}

export function newRequestId(crypto = globalThis.crypto) {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  if (!crypto?.getRandomValues) throw new Error('This browser cannot create a safe save receipt. Use a current browser.')
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const h = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Keep this object on failure. Re-exporting PNG on retry can change the receipt digest. */
export function makeSaveReceipt({ revision, photo, artwork, proof, recipe, mediaTicket = '' }, requestId = newRequestId()) {
  return Object.freeze({ revision, photo, artwork, proof, recipeJSON: JSON.stringify(recipe), mediaTicket, requestId })
}

export function receiptFormData(receipt) {
  const form = new FormData()
  form.append('photo', receipt.photo, receipt.photo.name || 'shop-photo.png')
  form.append('artwork', receipt.artwork, receipt.artwork.name || 'original-artwork.png')
  form.append('proof', receipt.proof, 'appearance-mockup.png')
  form.append('revision', String(receipt.revision))
  form.append('request_id', receipt.requestId)
  form.append('recipe', receipt.recipeJSON)
  if (receipt.mediaTicket) form.append('media_ticket', receipt.mediaTicket)
  return form
}
