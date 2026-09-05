/* Hallmark · pre-emit critique: P5 H4 E4 S5 R5 V4
 * Component scope: existing workbench tokens, no macrostructure change.
 * Appearance approval and a human's production-file review are distinct records.
 */
import { api, esc, fmtDate, guardLeave, confirmModal, go } from './core.js'

const drafts = new Map()
let active = null
const methods = ['Screen Print', 'DTF', 'Embroidery', 'UV DTF', 'Vinyl', 'Patch', 'Laser', 'Other']
const checked = value => value ? ' checked' : ''
const bytes = size => Number(size) >= 1048576 ? `${(Number(size) / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(Number(size || 0) / 1024))} KB`
const safeUrl = value => {
  if (typeof value !== 'string' || !value.trim()) return ''
  try { const u = new URL(value, location.href); return ['http:', 'https:'].includes(u.protocol) ? esc(u.href) : '' } catch { return '' }
}
const fileLink = file => {
  const url = safeUrl(file.url)
  return url ? `<a href="${url}" target="_blank" rel="noopener">${esc(file.original_name || `File ${file.id}`)}</a>` : esc(file.original_name || `File ${file.id}`)
}
function newDraft(job) {
  return { method: job.decoration || '', print_width: '', print_height: '', units: 'in', ink_notes: '', machine_profile: '', notes: '', source: [], production: [], confirmed: false, dirty: false, files: {}, reviewOpen: false, revokeNote: '' }
}
function loadStyle() {
  if (document.getElementById('art-production-style')) return
  const link = document.createElement('link')
  link.id = 'art-production-style'; link.rel = 'stylesheet'; link.href = '/css/art-production.css'
  document.head.appendChild(link)
}

export function artProductionContent(data, draft, manager, jobId) {
  const appearance = data.appearance
  const approved = appearance?.approved === true
  const appearanceUrl = safeUrl(appearance?.url)
  const locked = appearance?.purpose === 'appearance_mockup'
  const accept = Array.isArray(data.allowed_upload_types) ? data.allowed_upload_types.join(',') : ''
  const limit = Number(data.max_file_bytes) || 40 * 1024 * 1024
  const reviewedSpecs = data.release?.specs || {}
  const list = role => {
    const files = data[`${role}_files`] || []
    return files.length ? `<ul class="artp-files">${files.map(file => `<li><div>${fileLink(file)}<small>${esc(file.mime || 'File')} · ${bytes(file.size)}</small>${file.sha256 ? `<details><summary>File fingerprint</summary><code>${esc(file.sha256)}</code></details>` : ''}</div></li>`).join('')}</ul>` : `<p class="artp-muted">${role === 'source' ? 'Keep the customer’s original artwork here.' : 'Add the files your team will actually print, cut or stitch.'}</p>`
  }
  const upload = role => `<form class="artp-upload" data-artp-upload="${role}"><label class="artp-file-picker">Choose ${role === 'source' ? 'original' : 'production file'}<input type="file" name="file" accept="${esc(accept)}" aria-describedby="artp-message-${jobId}" aria-label="Choose ${role === 'source' ? 'original artwork' : 'prepared production file'}"></label><span class="artp-selected" data-artp-selected="${role}">${esc(draft.files[role]?.name || 'No file chosen')} · ${bytes(limit)} maximum</span><button class="btn ghost" type="submit"${draft.files[role] ? '' : ' disabled'}>Upload file</button></form>`
  const selections = role => `<fieldset class="artp-file-selection"><legend>${role === 'source' ? 'Originals used (optional)' : 'Production files reviewed'}</legend>${(data[`${role}_files`] || []).map(file => `<label class="artp-check"><input type="checkbox" name="${role}_asset" value="${file.id}"${checked(draft[role].includes(file.id))}><span>${esc(file.original_name || `File ${file.id}`)}</span></label>`).join('') || `<p class="artp-muted">${role === 'source' ? 'No original files attached.' : 'Upload at least one production file first.'}</p>`}</fieldset>`
  const input = (name, label, options = '') => `<label class="artp-field">${label}<input class="input" name="${name}" value="${esc(draft[name])}" ${options}></label>`
  const methodOptions = [...new Set([draft.method, ...methods].filter(Boolean))]
  return `<div class="card-h"><h3>Production files & review</h3></div><div class="card-b artp-body">
    <div class="artp-status-row"><span>Customer appearance</span><strong>${appearance ? `v${appearance.version} · ${approved ? 'Approved' : esc(appearance.status)}` : 'No proof'}</strong></div>
    ${appearanceUrl ? `<a class="artp-proof-link" href="${appearanceUrl}" target="_blank" rel="noopener">View current proof</a>` : ''}
    <div class="artp-status-row"><span>Technical review</span><strong class="${data.technical_ready ? 'artp-ready' : ''}">${data.technical_ready ? 'Released for production' : 'Not released'}</strong></div>
    <p class="artp-muted">Customer approval records the appearance. A shop reviewer checks the separate production files for the equipment and method.</p>
    ${data.release && data.technical_ready ? `<div class="artp-record"><p>Reviewed by ${esc(data.release.reviewed_by || 'Shop reviewer')} · ${fmtDate(data.release.reviewed_at)}</p>${reviewedSpecs.method ? `<p>${esc(reviewedSpecs.method)} · ${esc(reviewedSpecs.print_width)} × ${esc(reviewedSpecs.print_height)} ${esc(reviewedSpecs.units)}</p>` : ''}${reviewedSpecs.machine_profile ? `<p>${esc(reviewedSpecs.machine_profile)}</p>` : ''}${reviewedSpecs.ink_notes ? `<p>${esc(reviewedSpecs.ink_notes)}</p>` : ''}${data.release.notes ? `<p>${esc(data.release.notes)}</p>` : ''}</div>` : ''}
    ${data.blocking_reasons?.length ? `<ul class="artp-reasons">${data.blocking_reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}
    <section class="artp-section"><h4>Original artwork</h4>${list('source')}${upload('source')}</section>
    <section class="artp-section"><h4>Prepared production files</h4>${list('production')}${upload('production')}</section>
    <div class="artp-message" id="artp-message-${jobId}" role="status" aria-live="polite" data-artp-message></div>
    <button class="btn ghost" type="button" data-artp-refresh>Refresh files</button>
    ${manager ? `<details class="artp-review"${draft.reviewOpen ? ' open' : ''}><summary>Review and release</summary>
      <form data-artp-review>
        <p class="artp-muted">Open and check the files below. This records your review; the software does not verify separations, stitch files or machine output.</p>
        <p data-artp-proof-note>Current customer proof: ${appearance ? `v${appearance.version} · ${approved ? 'approved' : esc(appearance.status)}` : 'none'}. ${approved ? '' : 'An approved current proof is needed to release.'}</p>
        ${selections('production')}${selections('source')}
        <label class="artp-field">Decoration method<select class="input" name="method" required aria-required="true"><option value="">Choose method</option>${methodOptions.map(method => `<option value="${esc(method)}"${draft.method === method ? ' selected' : ''}>${esc(method)}</option>`).join('')}</select></label>
        <div class="artp-dimensions">${input('print_width', 'Reviewed width', 'type="number" min="0.001" step="any" inputmode="decimal" required aria-required="true"')}${input('print_height', 'Reviewed height', 'type="number" min="0.001" step="any" inputmode="decimal" required aria-required="true"')}<label class="artp-field">Units<select class="input" name="units"><option value="in"${draft.units === 'in' ? ' selected' : ''}>Inches</option><option value="cm"${draft.units === 'cm' ? ' selected' : ''}>Centimeters</option><option value="mm"${draft.units === 'mm' ? ' selected' : ''}>Millimeters</option></select></label></div>
        <p class="artp-muted">Enter the dimensions you checked; this does not resize or generate a file. Record multiple placements and machine-specific requirements in the review notes.</p>
        ${input('ink_notes', 'Inks / thread / material notes', 'maxlength="2000"')}${input('machine_profile', 'Machine / RIP / stitch profile', 'maxlength="500"')}
        <label class="artp-field">Review notes<textarea class="input" name="notes" rows="3" maxlength="2000">${esc(draft.notes)}</textarea></label>
        <label class="artp-check artp-confirm"><input type="checkbox" name="reviewed_confirmed" required aria-required="true"${checked(draft.confirmed)}><span>I checked the selected files, dimensions and equipment requirements against the current approved proof.</span></label>
        <p class="artp-muted" data-artp-draft-note>${draft.dirty ? 'Review edits are not saved.' : ''}</p>
        <p class="artp-muted">Recording a release also requires a new review when this job’s proof or files change.</p><button class="btn" type="submit"${!approved || !(data.production_files || []).length ? ' disabled' : ''}>Release for production</button>
      </form>
    </details>
    <details class="artp-advanced"><summary>Advanced production controls</summary><p class="artp-muted">${data.required ? 'This job must have a current technical release before production.' : 'Technical review is optional for this existing job. Files are still shown as unreviewed until released.'}</p><label class="artp-check"><input type="checkbox" data-artp-required${checked(data.required)}${locked ? ' disabled' : ''}><span>Require technical release on this job</span></label>${locked ? '<p class="artp-muted">A garment mockup requires separate reviewed production files.</p>' : ''}
      ${data.release && data.technical_ready ? `<form data-artp-revoke><label class="artp-field">Reason for revoking release<textarea class="input" name="note" required aria-required="true" rows="2" maxlength="2000">${esc(draft.revokeNote)}</textarea></label><button class="btn ghost" type="submit">Revoke release</button></form>` : ''}
    </details>` : '<p class="artp-muted">A manager can review files and release this job for production.</p>'}
    <a class="btn ghost" href="/api/jobs/${jobId}/print-package?download=1">Production manifest</a>
  </div>`
}

export async function mountArtProduction(root, jobId, job) {
  if (!root) return
  loadStyle()
  const key = String(jobId)
  const draft = drafts.get(key) || newDraft(job)
  // A job redraw may follow a proof upload. Never carry a checked review declaration to new data.
  draft.confirmed = false
  drafts.set(key, draft)
  let data = null, busy = false, stale = false
  active = { root, draft, busy: () => busy }
  const pending = () => draft.dirty || Object.keys(draft.files).length > 0 || !!draft.revokeNote || busy
  guardLeave(to => {
    if (!root.isConnected || !pending()) return true
    if (busy) { message('Wait for the current file operation to finish before leaving.', true); return false }
    confirmModal('Leave without saving?', 'The review edits and selected uploads are only in this browser. Leaving discards them.', () => { drafts.delete(key); draft.dirty = false; draft.files = {}; draft.revokeNote = ''; go(to) }, 'Discard changes')
    return false
  })
  function message(text, error = false) {
    const node = root.querySelector('[data-artp-message]')
    if (!node) return
    node.textContent = text; node.dataset.state = error ? 'error' : 'success'
    node.setAttribute('role', error ? 'alert' : 'status')
    if (error) { node.tabIndex = -1; node.focus({ preventScroll: true }); node.scrollIntoView?.({ block: 'nearest' }) }
  }
  function capture(form) {
    if (!form) return
    for (const name of ['method', 'print_width', 'print_height', 'units', 'ink_notes', 'machine_profile', 'notes']) draft[name] = form.elements[name].value
    draft.source = [...form.querySelectorAll('[name="source_asset"]:checked')].map(el => Number(el.value))
    draft.production = [...form.querySelectorAll('[name="production_asset"]:checked')].map(el => Number(el.value))
    draft.confirmed = form.elements.reviewed_confirmed.checked
  }
  function draw() {
    if (!root.isConnected) return
    root.innerHTML = artProductionContent(data, draft, window.__me?.can_manage !== false, jobId)
    wire()
  }
  async function refresh(success = '', explicit = false, captureDraft = true) {
    if (busy) return
    if (captureDraft) capture(root.querySelector('[data-artp-review]'))
    const previous = data
    busy = true; root.setAttribute('aria-busy', 'true')
    const refreshButton = root.querySelector('[data-artp-refresh]')
    const restoreRefreshFocus = document.activeElement === refreshButton
    if (refreshButton) { refreshButton.disabled = true; refreshButton.textContent = 'Refreshing…' }
    syncDisabled()
    try {
      const latest = await api.get(`/api/jobs/${jobId}/art-production`)
      if (!root.isConnected) return
      data = latest; stale = false
      const changed = previous && (previous.revision !== latest.revision || previous.appearance?.id !== latest.appearance?.id)
      if (changed || explicit) draft.confirmed = false
      draft.source = draft.source.filter(id => latest.source_files.some(file => file.id === id))
      draft.production = draft.production.filter(id => latest.production_files.some(file => file.id === id))
      draw()
      if (success) message(success)
      else if (changed || explicit) message('Files refreshed. Your review notes are kept; check the current proof and confirm the review again.')
    } catch (error) {
      if (!root.isConnected) return
      stale = true
      if (!data) root.innerHTML = `<div class="card-h"><h3>Production files & review</h3></div><div class="card-b artp-body"><p role="alert">${esc(error.message)}</p><button class="btn ghost" type="button" data-artp-refresh>Retry loading files</button></div>`
      else message(`${success ? `${success} The file list could not refresh. ` : ''}${error.message} Refresh files before another change.`, true)
      const retry = root.querySelector('[data-artp-refresh]'); if (retry) retry.onclick = () => refresh('', true)
    } finally {
      busy = false; root.removeAttribute('aria-busy'); syncDisabled()
      if (restoreRefreshFocus) root.querySelector('[data-artp-refresh]')?.focus()
    }
  }
  function syncDisabled() {
    root.querySelectorAll('input:not([data-artp-required]), select, textarea').forEach(el => { el.disabled = busy })
    root.querySelectorAll('button[type="submit"], [data-artp-required]').forEach(el => {
      const uploadRole = el.closest('[data-artp-upload]')?.dataset.artpUpload
      el.disabled = busy || stale || (uploadRole ? !draft.files[uploadRole] : el.closest('[data-artp-review]') ? !data?.appearance?.approved || !data?.production_files?.length : el.matches('[data-artp-required]') && data?.appearance?.purpose === 'appearance_mockup')
    })
    const button = root.querySelector('[data-artp-refresh]')
    if (button) { button.disabled = busy; button.textContent = busy ? 'Refreshing…' : data ? 'Refresh files' : 'Retry loading files' }
  }
  async function mutate(path, body, button, success, after) {
    if (busy || stale) return
    busy = true; root.setAttribute('aria-busy', 'true'); syncDisabled()
    const oldLabel = button?.textContent
    if (button) button.textContent = 'Saving…'
    let saved = false
    try {
      await api.post(`/api/jobs/${jobId}/${path}`, body)
      saved = true; after?.()
    } catch (error) {
      if (error.status === 409 || !error.status || error.status >= 500) {
        stale = true; draft.confirmed = false
        const confirm = root.querySelector('[name="reviewed_confirmed"]'); if (confirm) confirm.checked = false
      }
      message(`${error.message}${stale ? ' Refresh files before retrying; your review notes are kept.' : ''}`, true)
    } finally {
      busy = false; root.removeAttribute('aria-busy')
      if (button) button.textContent = oldLabel
      syncDisabled()
    }
    if (saved) await refresh(success, false, false)
  }
  function wire() {
    root.querySelector('[data-artp-refresh]').onclick = () => refresh('', true)
    for (const form of root.querySelectorAll('[data-artp-upload]')) {
      const role = form.dataset.artpUpload
      form.elements.file.onchange = () => {
        const file = form.elements.file.files[0]
        const limit = Number(data.max_file_bytes) || 40 * 1024 * 1024
        if (file && file.size > limit) {
          delete draft.files[role]; form.elements.file.value = ''; form.elements.file.setAttribute('aria-invalid', 'true')
          root.querySelector(`[data-artp-selected="${role}"]`).textContent = 'No file chosen'
          message(`That file exceeds ${bytes(limit)}. Choose a smaller file.`, true); syncDisabled(); return
        }
        form.elements.file.removeAttribute('aria-invalid')
        if (file) draft.files[role] = file; else delete draft.files[role]
        root.querySelector(`[data-artp-selected="${role}"]`).textContent = file?.name || 'No file chosen'
        syncDisabled()
      }
      form.onsubmit = async event => {
        event.preventDefault()
        if (!draft.files[role]) return
        const sentFile = draft.files[role]
        const body = new FormData(); body.append('file', sentFile); body.append('role', role); body.append('revision', String(data.revision))
        await mutate('art-assets', body, form.querySelector('button'), 'File uploaded. A new review is needed before production.', () => { capture(root.querySelector('[data-artp-review]')); if (draft.files[role] === sentFile) delete draft.files[role]; draft.confirmed = false })
      }
    }
    const review = root.querySelector('[data-artp-review]')
    if (review) {
      review.closest('details').ontoggle = event => { draft.reviewOpen = event.target.open }
      review.addEventListener('invalid', event => { event.target.setAttribute('aria-invalid', 'true') }, true)
      review.oninput = event => { capture(review); draft.dirty = true; event.target.removeAttribute('aria-invalid'); root.querySelector('[data-artp-draft-note]').textContent = 'Review edits are not saved.' }
      review.onchange = review.oninput
      review.onsubmit = async event => {
        event.preventDefault(); capture(review)
        if (!review.reportValidity()) return
        if (!draft.production.length) { message('Select at least one production file you reviewed.', true); review.querySelector('[name="production_asset"]')?.focus(); return }
        if (!draft.confirmed) return
        const body = { revision: data.revision, proof_id: data.appearance?.id, production_asset_ids: draft.production, source_asset_ids: draft.source, specs: { method: draft.method, print_width: Number(draft.print_width), print_height: Number(draft.print_height), units: draft.units, ink_notes: draft.ink_notes, machine_profile: draft.machine_profile }, notes: draft.notes, reviewed_confirmed: true }
        const reviewValues = () => JSON.stringify([draft.method, draft.print_width, draft.print_height, draft.units, draft.ink_notes, draft.machine_profile, draft.notes, draft.source, draft.production])
        const submitted = reviewValues()
        await mutate('art-release', body, review.querySelector('button'), 'Technical review recorded. This release is linked to the current proof and selected files.', () => { capture(review); draft.dirty = submitted !== reviewValues(); draft.confirmed = false; draft.reviewOpen = draft.dirty })
      }
    }
    const requirement = root.querySelector('[data-artp-required]')
    if (requirement) requirement.onchange = async () => {
      const required = requirement.checked
      await mutate('art-production/require', { revision: data.revision, required }, null, required ? 'Technical release is now required.' : 'Technical release is optional. File review status is unchanged.')
      requirement.checked = !!data.required
    }
    const revoke = root.querySelector('[data-artp-revoke]')
    if (revoke) {
      revoke.oninput = () => { draft.revokeNote = revoke.elements.note.value }
      revoke.onsubmit = async event => {
        event.preventDefault()
        if (!revoke.reportValidity()) return
        await mutate('art-release/revoke', { revision: data.revision, note: revoke.elements.note.value }, revoke.querySelector('button'), 'Technical release revoked. The job needs another review.', () => { draft.revokeNote = ''; draft.confirmed = false })
      }
    }
    syncDisabled()
  }
  await refresh()
}

if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  if (!active?.root?.isConnected) return
  if (!active.draft.dirty && !Object.keys(active.draft.files).length && !active.draft.revokeNote && !active.busy()) return
  event.preventDefault(); event.returnValue = ''
})
