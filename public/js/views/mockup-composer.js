import { $, esc, setPage, toast, go, guardLeave, confirmModal } from '../core.js'
import { MOCKUP_LIMITS } from '../shared/raster-header.js'
import { INITIAL_PLACEMENT, clamp, inspectRaster, decodeRaster, validateInputHeader, makeRecipe, paintMockup, movePlacement, artworkClipped, exportProof, makeSaveReceipt, receiptFormData } from '../shared/mockup-canvas.js'

let activeCleanup = null

function loadStyles() {
  if (document.querySelector('link[data-mockup-composer]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'; link.href = '/css/mockup-composer.css'; link.dataset.mockupComposer = ''
  document.head.append(link)
}

// Unlike the general API wrapper, an expired session must not navigate away from unsaved files.
async function jsonRequest(url, options = {}) {
  let response
  try { response = await fetch(url, { credentials: 'same-origin', ...options }) }
  catch (error) { if (error.name === 'AbortError') throw error; throw new Error('The connection was interrupted. Your draft is still here; retry when connected.') }
  let data
  try { data = await response.json() } catch { /* proxy/restart response */ }
  if (!response.ok || !data) {
    const message = response.status === 401 ? 'Your session expired. Sign in in another tab, then retry here to keep this draft.'
      : response.status === 413 ? 'The upload was rejected as too large. Your draft is still here.'
      : response.status === 429 ? 'Too many requests just now. Wait a moment, then retry.'
      : data?.error || 'The server could not confirm this request. Your draft is still here; retry in a moment.'
    const error = new Error(message); error.status = response.status; error.code = data?.code; error.data = data
    throw error
  }
  return data
}

/** Bound the bytes even when a proxy omits or lies about Content-Length. */
async function mediaFile(mediaId, signal) {
  const response = await fetch(`/api/catalog/ss/media/${encodeURIComponent(mediaId)}`, { credentials: 'same-origin', signal })
  if (!response.ok) {
    let data; try { data = await response.json() } catch { /* non-JSON */ }
    throw new Error(data?.error || (response.status === 401 ? 'Your session expired. Sign in in another tab, then select the photo again.' : 'This supplier photo is unavailable. Look up the exact SKU again or upload your own photo.'))
  }
  const ticket = response.headers.get('X-PSC-Media-Ticket')
  if (!ticket) throw new Error('The supplier photo has no verified source receipt. Look up the SKU again, or upload a shop photo.')
  if (Number(response.headers.get('content-length')) > MOCKUP_LIMITS.inputBytes) { await response.body?.cancel(); throw new Error('This supplier image exceeds 10 MiB. Use a smaller shop photo.') }
  if (!response.body?.getReader) throw new Error('This browser cannot safely download supplier images. Upload a shop photo instead.')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MOCKUP_LIMITS.inputBytes) { await reader.cancel(); throw new Error('This supplier image exceeds 10 MiB. Use a smaller shop photo.') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const mime = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime] || 'image'
  return { file: new File(chunks, `ss-product-photo.${extension}`, { type: mime }), ticket }
}

export async function mockupComposerView(jobId) {
  activeCleanup?.()
  loadStyles()
  const id = String(jobId)
  if (!/^\d+$/.test(id)) throw new Error('Choose a job before creating a mockup.')
  setPage('Create appearance mockup', `<a class="btn ghost" href="#/jobs/${id}">Back to job</a>`, '<a href="#/board">Board</a> /')
  $('#view').innerHTML = `<section class="mockup-composer" aria-labelledby="mc-title">
    <header class="mc-intro"><div><h2 id="mc-title">Place original artwork on a product photo</h2><p id="mc-job-context" class="mc-muted" role="status">Loading job…</p></div><span class="mc-local-label">Made on your device · No AI</span></header>
    <p class="mc-explanation">Move and resize your artwork without redrawing it. Placement is visual; photo perspective and print dimensions are not calibrated. Saving uploads a draft proof and private originals for this job.</p>
    <div id="mc-job-error" class="mc-error" role="alert" hidden></div>
    <button type="button" class="btn ghost" id="mc-retry-job" hidden>Retry loading job, keep this draft</button>
    <div class="mc-workspace">
      <div class="mc-preview-column">
        <section class="mc-preview-panel" aria-labelledby="mc-preview-title">
          <div class="mc-section-heading"><h3 id="mc-preview-title">Appearance preview</h3><span id="mc-output-size" class="mc-muted"></span></div>
          <div class="mc-stage" id="mc-stage"><div id="mc-empty" class="mc-empty"><strong>Start with a product photo</strong><p>Then add the artwork your customer supplied.</p></div><canvas id="mc-canvas" width="1" height="1" tabindex="0" role="img" aria-label="Mockup preview. Drag to move artwork, or use arrow keys. Hold Shift for a larger step." aria-describedby="mc-canvas-help mc-clipped" hidden></canvas></div>
          <p id="mc-canvas-help" class="mc-help">Drag to move. Arrow keys move artwork; Shift takes a larger step. Size, rotation and exact placement are editable below.</p>
          <p id="mc-clipped" class="mc-warning" role="status" hidden>Some artwork is outside the photo and will be cropped in the proof. Move it inward or reduce its size.</p>
        </section>
        <section class="mc-panel" aria-labelledby="mc-placement-title">
          <div class="mc-section-heading"><h3 id="mc-placement-title">Placement</h3><button type="button" class="btn ghost" id="mc-reset" disabled>Reset placement</button></div>
          <fieldset id="mc-placement-fields" class="mc-fieldset" disabled><legend class="sr-only">Artwork placement</legend>
            <div class="mc-placement-grid">
              <label>Across photo (%)<input class="input" id="mc-x" type="number" inputmode="decimal" min="0" max="100" step="0.1" value="50"></label>
              <label>Down photo (%)<input class="input" id="mc-y" type="number" inputmode="decimal" min="0" max="100" step="0.1" value="40"></label>
              <label>Artwork width (%)<input class="input" id="mc-width" type="number" inputmode="decimal" min="1" max="200" step="0.1" value="30"></label>
              <label>Rotation (degrees)<input class="input" id="mc-rotation" type="number" inputmode="decimal" min="-180" max="180" step="1" value="0"></label>
            </div><p class="mc-help">Across and down set the artwork’s center. Width is a percentage of the photo. Artwork proportions stay locked.</p>
            <label class="mc-range-label" for="mc-size-range">Artwork size<input id="mc-size-range" type="range" min="1" max="200" step="0.1" value="30"></label>
          </fieldset>
          <div id="mc-placement-error" class="mc-error" role="alert" hidden></div>
          <details class="mc-details"><summary>Requested print size (optional)</summary><p class="mc-help">Notes for human review only. These values do not calibrate this photo, resize the original or prepare a production file.</p>
            <fieldset id="mc-print-fields" class="mc-fieldset"><legend class="sr-only">Requested print size</legend><div class="mc-print-grid">
              <label>Width<input class="input" id="mc-print-width" type="number" inputmode="decimal" min="0.001" step="any" placeholder="Optional"></label>
              <label>Height<input class="input" id="mc-print-height" type="number" inputmode="decimal" min="0.001" step="any" placeholder="Optional"></label>
              <label>Units<select class="input" id="mc-units"><option value="in">Inches</option><option value="mm">Millimeters</option><option value="cm">Centimeters</option></select></label>
            </div></fieldset>
          </details>
        </section>
      </div>
      <div class="mc-source-column">
        <section class="mc-panel" aria-labelledby="mc-photo-title"><h3 id="mc-photo-title">1. Product photo</h3><p class="mc-help">Use a clear photo of the actual product and color.</p>
          <label class="mc-file-pick btn ghost">Choose shop photo<input id="mc-photo-input" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"></label>
          <p id="mc-photo-meta" class="mc-file-meta">No photo selected</p><p id="mc-photo-status" class="mc-help" role="status"></p><div id="mc-photo-error" class="mc-error" role="alert" hidden></div>
          <button type="button" id="mc-cancel-photo" class="btn ghost" hidden>Cancel photo loading</button>
          <button type="button" id="mc-clear-ticket" class="btn ghost" hidden>Use as unverified shop photo</button>
          <details class="mc-details"><summary>Use an S&amp;S catalog photo</summary><p class="mc-help">Requires your shop’s configured S&amp;S API credentials. Enter an exact SKU, including its color and size variant.</p>
            <form id="mc-supplier-form"><label>Exact S&amp;S SKU<input class="input" id="mc-sku" autocomplete="off" maxlength="120" required></label><button type="submit" class="btn ghost" id="mc-lookup">Find available photos</button></form>
            <p id="mc-supplier-status" class="mc-help" role="status"></p><div id="mc-supplier-error" class="mc-error" role="alert" hidden></div><div id="mc-supplier-result"></div>
          </details>
        </section>
        <section class="mc-panel" aria-labelledby="mc-artwork-title"><h3 id="mc-artwork-title">2. Original artwork</h3><p class="mc-help">A transparent PNG or WebP usually places best. An opaque background remains visible.</p>
          <label class="mc-file-pick btn ghost">Choose original artwork<input id="mc-artwork-input" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"></label>
          <p id="mc-artwork-meta" class="mc-file-meta">No artwork selected</p><p id="mc-artwork-status" class="mc-help" role="status"></p><div id="mc-artwork-error" class="mc-error" role="alert" hidden></div><button type="button" id="mc-cancel-artwork" class="btn ghost" hidden>Cancel artwork loading</button>
        </section>
        <p class="mc-help mc-limits">Still PNG, JPEG or WebP. Up to 10 MiB per file, 4096 pixels per edge and 8 million pixels combined. Originals keep their uploaded bytes; the preview is resized to at most 2000 pixels per edge.</p>
        <section class="mc-panel mc-save-panel" aria-labelledby="mc-save-title"><h3 id="mc-save-title">3. Save for review</h3><p class="mc-help">This saves an appearance draft. Customer approval and staff production review happen separately on the job.</p><button type="button" class="btn" id="mc-save" disabled>Save draft mockup</button>
          <p id="mc-save-status" class="mc-help" role="status">Add both images to continue.</p><div id="mc-save-error" class="mc-error" role="alert" hidden></div>
          <a id="mc-sign-in" class="btn ghost" href="/login" target="_blank" rel="noopener" hidden>Sign in in another tab</a>
          <button type="button" id="mc-refresh-revision" class="btn ghost" hidden>Refresh job version, keep this draft</button>
          <button type="button" class="btn ghost" id="mc-cancel">Back to job</button>
        </section>
      </div>
    </div>
  </section>`
  const root = $('.mockup-composer'), find = selector => $(selector, root)
  // Source selection precedes placement in keyboard and phone reading order. Desktop places
  // the larger preview beside those inputs; save remains the final section in both layouts.
  const workspace = find('.mc-workspace'), sources = find('.mc-source-column'), savePanel = find('.mc-save-panel')
  workspace.prepend(sources); workspace.append(savePanel)
  const canvas = find('#mc-canvas'), context = canvas.getContext('2d')
  const slots = { photo: null, artwork: null }, generation = { photo: 0, artwork: 0 }
  const loading = { photo: false, artwork: false }
  let alive = true, dirty = false, saving = false, revision = null, placement = { ...INITIAL_PLACEMENT }
  let inputTasks = 0
  let receipt = null, raf = null, drag = null, supplierAbort = null, photoAbort = null, lookupSequence = 0, supplierBusy = false
  let stale = false, saveFailed = false, observer

  function showError(selector, message = '') { const node = find(selector); node.textContent = message; node.hidden = !message }
  function markChanged() {
    dirty = true; receipt = null; saveFailed = false
    showError('#mc-save-error'); find('#mc-sign-in').hidden = true
    if (!stale) find('#mc-save-status').textContent = 'Unsaved draft. Files stay in this tab until you save.'
    updateControls()
  }
  function updateControls() {
    const processing = loading.photo || loading.artwork || inputTasks > 0
    const ready = !!(slots.photo && slots.artwork && context)
    find('#mc-save').disabled = saving || processing || !ready || revision === null || stale
    find('#mc-save').textContent = saving ? 'Saving draft…' : saveFailed && receipt ? 'Retry same draft save' : 'Save draft mockup'
    find('#mc-placement-fields').disabled = saving || !ready
    find('#mc-reset').disabled = saving || !ready
    find('#mc-print-fields').disabled = saving
    // ImageBitmap decode cannot be aborted. Keep new native selections blocked until an
    // already-started decode settles, even after Cancel, so repeated replacements cannot
    // accumulate decoded buffers. Stale results are closed before enabling these again.
    find('#mc-photo-input').disabled = saving || inputTasks > 0
    find('#mc-artwork-input').disabled = saving || inputTasks > 0
    find('#mc-sku').disabled = saving || supplierBusy
    find('#mc-lookup').disabled = saving || supplierBusy
    find('#mc-lookup').textContent = supplierBusy ? 'Finding photos…' : 'Find available photos'
    find('#mc-refresh-revision').disabled = saving
    find('#mc-clear-ticket').disabled = saving || processing
    for (const button of root.querySelectorAll('[data-media-id]')) button.disabled = saving || loading.photo || inputTasks > 0
    for (const role of ['photo', 'artwork']) find(`#mc-cancel-${role}`).hidden = !loading[role]
    canvas.setAttribute('aria-disabled', String(saving || !ready))
    root.setAttribute('aria-busy', String(saving))
  }
  function syncPlacementInputs() {
    for (const [key, factor] of [['x', 100], ['y', 100], ['width', 100], ['rotation', 1]]) find(`#mc-${key}`).value = String(Math.round(placement[key] * factor * 1000) / 1000)
    find('#mc-size-range').value = String(placement.width * 100)
  }
  function render() {
    if (raf !== null) cancelAnimationFrame(raf)
    raf = null
    if (!alive || !slots.photo || !context) return
    const recipe = makeRecipe(slots.photo.header, placement)
    if (canvas.width !== recipe.canvas.width || canvas.height !== recipe.canvas.height) { canvas.width = recipe.canvas.width; canvas.height = recipe.canvas.height }
    paintMockup(context, slots.photo.bitmap, slots.artwork?.bitmap, recipe)
    canvas.hidden = false; find('#mc-empty').hidden = true
    find('#mc-output-size').textContent = `${canvas.width} × ${canvas.height} px`
    find('#mc-clipped').hidden = !artworkClipped(recipe.canvas, slots.artwork?.bitmap, placement)
  }
  function scheduleRender() { if (raf === null) raf = requestAnimationFrame(render) }
  function updateFileMeta(role) {
    const asset = slots[role]
    find(`#mc-${role}-meta`).textContent = asset ? `${asset.file.name} · ${asset.header.orientedWidth} × ${asset.header.orientedHeight} px · ${(asset.file.size / 1048576).toFixed(2)} MiB` : `No ${role === 'photo' ? 'photo' : 'artwork'} selected`
    if (role === 'photo') {
      find('#mc-photo-status').textContent = asset?.supplierLabel ? `Verified supplier source: ${asset.supplierLabel}` : asset ? 'Shop photo. Confirm product and color during review.' : ''
      find('#mc-clear-ticket').hidden = !asset?.mediaTicket
    } else find('#mc-artwork-status').textContent = asset ? 'Original file retained unchanged. Only this preview is resized.' : ''
  }
  async function selectFile(role, file, extra = {}, externalSequence = null) {
    if (!file || saving || !alive) return
    const seq = externalSequence ?? ++generation[role]
    inputTasks++
    loading[role] = true; showError(`#mc-${role}-error`)
    find(`#mc-${role}-status`).textContent = 'Checking image before opening…'; updateControls()
    let bitmap
    try {
      const other = role === 'photo' ? 'artwork' : 'photo'
      const header = await inspectRaster(file, slots[other]?.header)
      if (!alive || seq !== generation[role]) return
      bitmap = await decodeRaster(file, header)
      if (!alive || seq !== generation[role]) { bitmap.close?.(); return }
      // The other file may have finished decoding while this one was opening.
      validateInputHeader(header, slots[other]?.header)
      slots[role]?.bitmap.close?.()
      slots[role] = { file, header, bitmap, ...extra }; bitmap = null
      updateFileMeta(role); markChanged(); scheduleRender()
    } catch (error) {
      bitmap?.close?.()
      if (alive && seq === generation[role] && error.name !== 'AbortError') { updateFileMeta(role); showError(`#mc-${role}-error`, error.message) }
    } finally {
      inputTasks--
      if (alive) { if (seq === generation[role]) loading[role] = false; updateControls() }
    }
  }
  function cancelLoad(role) {
    generation[role]++; loading[role] = false
    if (role === 'photo') { photoAbort?.abort(); photoAbort = null }
    updateFileMeta(role); updateControls()
  }
  for (const role of ['photo', 'artwork']) {
    find(`#mc-${role}-input`).addEventListener('change', event => {
      const file = event.target.files?.[0]; event.target.value = ''
      if (role === 'photo') photoAbort?.abort()
      void selectFile(role, file)
    })
    find(`#mc-cancel-${role}`).addEventListener('click', () => cancelLoad(role))
  }
  find('#mc-clear-ticket').addEventListener('click', () => {
    if (saving || !slots.photo?.mediaTicket) return
    confirmModal('Remove supplier verification?', 'Keep this photo and placement, but save it as an unverified shop photo. Staff must confirm the product and color.', () => {
      if (!alive || saving || !slots.photo) return
      slots.photo.mediaTicket = ''; slots.photo.supplierLabel = ''; updateFileMeta('photo'); markChanged()
    }, 'Use as shop photo')
  })
  find('#mc-supplier-form').addEventListener('submit', async event => {
    event.preventDefault()
    const sku = find('#mc-sku').value.trim()
    if (!sku || saving || supplierBusy) return
    supplierAbort?.abort(); supplierAbort = new AbortController()
    const seq = ++lookupSequence
    supplierBusy = true; updateControls(); showError('#mc-supplier-error')
    find('#mc-supplier-result').innerHTML = ''; find('#mc-supplier-status').textContent = 'Looking up this exact SKU…'
    try {
      const product = await jsonRequest(`/api/catalog/ss/products/${encodeURIComponent(sku)}/media`, { signal: supplierAbort.signal })
      if (!alive || seq !== lookupSequence) return
      if (!Array.isArray(product.views) || !product.views.length) throw new Error('No usable photos are available for this exact SKU. Upload a shop photo instead.')
      const identity = [product.brand, product.style, product.color, product.size].filter(Boolean).join(' · ')
      find('#mc-supplier-status').textContent = `SKU ${product.sku} · ${identity}`
      const views = product.views.filter(view => typeof view.media_id === 'string' && view.media_id && typeof view.label === 'string')
      if (!views.length) throw new Error('No usable photos are available for this exact SKU. Upload a shop photo instead.')
      find('#mc-supplier-result').innerHTML = `<p class="mc-help">Choose an available view. Verify the photo before saving.</p><div class="mc-media-views">${views.map(view => `<button type="button" class="btn ghost" data-media-id="${esc(view.media_id)}">${esc(view.label)}</button>`).join('')}</div>`
      for (const button of find('#mc-supplier-result').querySelectorAll('[data-media-id]')) button.addEventListener('click', async () => {
        if (saving || loading.photo || inputTasks > 0) return
        const view = views.find(v => v.media_id === button.dataset.mediaId)
        photoAbort?.abort(); photoAbort = new AbortController()
        const photoSeq = ++generation.photo
        loading.photo = true; updateControls(); showError('#mc-photo-error')
        find('#mc-photo-status').textContent = 'Downloading the selected supplier view…'
        try {
          const { file, ticket } = await mediaFile(view.media_id, photoAbort.signal)
          if (!alive || photoSeq !== generation.photo) return
          await selectFile('photo', file, { mediaTicket: ticket, supplierLabel: `SKU ${product.sku} · ${identity} · ${view.label}` }, photoSeq)
        } catch (error) {
          if (alive && photoSeq === generation.photo && error.name !== 'AbortError') { updateFileMeta('photo'); showError('#mc-photo-error', error.message || 'The supplier photo could not be downloaded. Try again or choose a shop photo.') }
        } finally { if (alive && photoSeq === generation.photo) { loading.photo = false; updateControls() } }
      })
    } catch (error) {
      if (alive && seq === lookupSequence && error.name !== 'AbortError') { find('#mc-supplier-status').textContent = ''; showError('#mc-supplier-error', error.message) }
    } finally { if (alive && seq === lookupSequence) { supplierBusy = false; updateControls() } }
  })

  function placementFromFields() {
    const next = {}
    for (const [key, factor] of [['x', 100], ['y', 100], ['width', 100], ['rotation', 1]]) {
      const input = find(`#mc-${key}`)
      if (input.value === '' || !input.checkValidity()) throw new Error('Use across/down 0–100%, width 1–200%, and rotation −180 to 180 degrees.')
      next[key] = Number(input.value) / factor
    }
    return next
  }
  for (const key of ['x', 'y', 'width', 'rotation']) find(`#mc-${key}`).addEventListener('input', () => {
    markChanged()
    try { placement = placementFromFields(); find('#mc-size-range').value = String(placement.width * 100); showError('#mc-placement-error'); scheduleRender() }
    catch (error) { showError('#mc-placement-error', error.message) }
  })
  find('#mc-size-range').addEventListener('input', event => {
    placement.width = Number(event.target.value) / 100; syncPlacementInputs(); showError('#mc-placement-error'); markChanged(); scheduleRender()
  })
  find('#mc-reset').addEventListener('click', () => { placement = { ...INITIAL_PLACEMENT }; syncPlacementInputs(); showError('#mc-placement-error'); markChanged(); scheduleRender() })
  for (const key of ['mc-print-width', 'mc-print-height', 'mc-units']) find(`#${key}`).addEventListener('input', markChanged)
  canvas.addEventListener('keydown', event => {
    if (saving || !slots.artwork || !slots.photo) return
    const next = movePlacement(placement, event.key, event.shiftKey)
    if (!next) return
    event.preventDefault(); placement = next; syncPlacementInputs(); showError('#mc-placement-error'); markChanged(); scheduleRender()
  })
  canvas.addEventListener('pointerdown', event => {
    if (saving || !slots.artwork || !slots.photo || (event.pointerType === 'mouse' && event.button !== 0)) return
    if (drag) return
    event.preventDefault(); canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId)
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: placement.x, y: placement.y }
  })
  canvas.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id || saving) return
    const bounds = canvas.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    placement.x = clamp(drag.x + (event.clientX - drag.startX) / bounds.width, 0, 1)
    placement.y = clamp(drag.y + (event.clientY - drag.startY) / bounds.height, 0, 1)
    syncPlacementInputs(); showError('#mc-placement-error'); markChanged(); scheduleRender()
  })
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, event => { if (drag?.id === event.pointerId) drag = null })

  function readRequestedPrint() {
    const width = find('#mc-print-width').value, height = find('#mc-print-height').value
    if (!width && !height) return null
    return { width: Number(width), height: Number(height), units: find('#mc-units').value }
  }
  find('#mc-save').addEventListener('click', async () => {
    if (saving || inputTasks > 0 || loading.photo || loading.artwork || !slots.photo || !slots.artwork || revision === null || stale) return
    saving = true; updateControls(); showError('#mc-save-error'); find('#mc-sign-in').hidden = true
    find('#mc-save-status').textContent = receipt ? 'Retrying the same draft receipt…' : 'Preparing the PNG on your device…'
    try {
      if (!receipt) {
        placement = placementFromFields()
        const recipe = makeRecipe(slots.photo.header, placement, readRequestedPrint())
        render()
        const proof = await exportProof(canvas)
        if (!alive) return
        receipt = makeSaveReceipt({ revision, photo: slots.photo.file, artwork: slots.artwork.file, proof, recipe, mediaTicket: slots.photo.mediaTicket || '' })
      }
      find('#mc-save-status').textContent = 'Uploading draft proof and private originals…'
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 75000)
      let result
      try { result = await jsonRequest(`/api/jobs/${id}/mockup-compositions`, { method: 'POST', body: receiptFormData(receipt), signal: controller.signal }) }
      catch (error) { if (error.name === 'AbortError') throw new Error('The server did not confirm this save in time. Retry the same draft to check its receipt.'); throw error }
      finally { clearTimeout(timeout) }
      if (!alive) return
      if (!Number.isSafeInteger(result.proof_id) || String(result.job_id) !== id) throw new Error('The server response did not confirm this job’s saved proof. Retry the same draft to check its receipt.')
      dirty = false; saveFailed = false
      find('#mc-save-status').textContent = `Draft version ${result.version} saved.`
      toast('Appearance draft saved. Review and send it from the job.')
      go(`#/jobs/${id}`)
    } catch (error) {
      if (!alive) return
      saveFailed = true; showError('#mc-save-error', error.message)
      find('#mc-save-status').textContent = receipt ? 'Draft preserved. Retry sends the same files and receipt without creating a duplicate.' : 'Draft preserved. Correct the fields or files, then save again.'
      if (error.status === 401) find('#mc-sign-in').hidden = false
      if (['art_revision_conflict', 'mockup_receipt_unavailable', 'mockup_request_conflict'].includes(error.code)) { stale = true; find('#mc-refresh-revision').hidden = false }
    } finally {
      if (alive) {
        saving = false; updateControls()
        if (saveFailed) find(stale ? '#mc-refresh-revision' : '#mc-save').focus({ preventScroll: true })
      }
    }
  })
  find('#mc-refresh-revision').addEventListener('click', async () => {
    if (saving) return
    saving = true; updateControls(); showError('#mc-save-error')
    try {
      const job = await jsonRequest(`/api/jobs/${id}`)
      if (!alive) return
      if (!Number.isSafeInteger(job.art_revision)) throw new Error('The job version could not be read. Retry in a moment.')
      revision = job.art_revision; stale = false; receipt = null; saveFailed = false
      find('#mc-refresh-revision').hidden = true
      find('#mc-save-status').textContent = 'Job version refreshed. Review this draft, then save it as a new version; current approval will be cleared.'
    } catch (error) { if (alive) showError('#mc-save-error', error.message) }
    finally { if (alive) { saving = false; updateControls() } }
  })
  find('#mc-cancel').addEventListener('click', () => go(`#/jobs/${id}`))

  const beforeUnload = event => { if (alive && (dirty || saving)) { event.preventDefault(); event.returnValue = '' } }
  window.addEventListener('beforeunload', beforeUnload)
  function cleanup() {
    if (!alive) return
    alive = false; generation.photo++; generation.artwork++; lookupSequence++
    supplierAbort?.abort(); photoAbort?.abort(); if (raf !== null) cancelAnimationFrame(raf)
    for (const role of ['photo', 'artwork']) { slots[role]?.bitmap.close?.(); slots[role] = null }
    receipt = null; canvas.width = 1; canvas.height = 1; observer?.disconnect()
    window.removeEventListener('beforeunload', beforeUnload)
    if (activeCleanup === cleanup) activeCleanup = null
  }
  activeCleanup = cleanup
  observer = new MutationObserver(() => { if (!root.isConnected) cleanup() })
  observer.observe($('#view'), { childList: true })
  guardLeave(target => {
    if (!alive || (!dirty && !saving)) { cleanup(); return true }
    if (saving) { showError('#mc-save-error', 'Wait for this save to finish before leaving. A retry receipt must stay in this tab until the result is known.'); return false }
    confirmModal('Discard this unsaved mockup?', 'The images and placement are held in this tab. Leaving will discard this draft.', () => { dirty = false; cleanup(); go(target) }, 'Discard draft')
    return false
  })
  if (!context) showError('#mc-job-error', 'This browser cannot create a canvas preview. Use a current browser to create a mockup.')
  async function loadJob() {
    find('#mc-retry-job').disabled = true
    find('#mc-job-context').textContent = 'Loading job…'
    try {
      const job = await jsonRequest(`/api/jobs/${id}`)
      if (!alive) return
      if (!Number.isSafeInteger(job.art_revision)) throw new Error('The job has no current artwork version. Retry loading the job before saving.')
      revision = job.art_revision
      find('#mc-job-context').textContent = [job.job_number, job.title, job.contact_name].filter(Boolean).join(' · ')
      find('#mc-retry-job').hidden = true
      if (context) showError('#mc-job-error')
      updateControls()
    } catch (error) {
      if (alive) {
        find('#mc-job-context').textContent = 'Job could not be loaded.'; showError('#mc-job-error', error.message)
        find('#mc-retry-job').hidden = false
        if (error.status === 401) find('#mc-sign-in').hidden = false
      }
    } finally { if (alive) find('#mc-retry-job').disabled = false }
  }
  find('#mc-retry-job').addEventListener('click', loadJob)
  await loadJob()
}
