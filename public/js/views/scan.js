import { api, $, esc, setPage, on, toast } from '../core.js'

/**
 * Floor Mode — scan a work ticket's barcode with the phone camera, see the job, tap once to
 * advance it. Every competitor either has no barcoding or gates it behind the top tier and a
 * USB scanner; this is a phone page. Timestamps from these scans are ROI's labor actuals.
 *
 * Camera path uses BarcodeDetector (Android Chrome, desktop Chrome). Where it doesn't exist
 * (iOS Safari), the page is still fully usable: the job number is printed under the barcode
 * and the number pad is one tap away.
 */

let stream = null
let scanTimer = 0
let lastCode = ''
let lastCodeAt = 0

export async function scanView() {
  setPage('Floor Mode', '', '<span class="dim">Production</span>')
  stopCamera()
  const hasDetector = 'BarcodeDetector' in window
  $('#view').innerHTML = `
    <div class="scan-wrap">
      <div class="card scan-cam-card">
        <video id="scan-video" playsinline muted style="display:none"></video>
        <div id="scan-cam-hint" class="dim" style="padding:14px">
          ${hasDetector ? '📷 Point the camera at a work-ticket barcode.' : 'Camera scanning needs Chrome on Android — type the job number below instead.'}
        </div>
        ${hasDetector ? '<button class="btn" id="scan-start">Start camera</button>' : ''}
      </div>
      <form id="scan-form" class="scan-form" autocomplete="off">
        <input id="scan-input" name="code" inputmode="text" placeholder="Job number — e.g. JOB-1042" autofocus />
        <button class="btn primary" type="submit">Find job</button>
      </form>
      <div id="scan-job"></div>
    </div>`

  on($('#view'), '#scan-start', async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      const v = $('#scan-video')
      v.srcObject = stream
      v.style.display = 'block'
      $('#scan-cam-hint').textContent = 'Scanning…'
      await v.play()
      const detector = new window.BarcodeDetector({ formats: ['code_128'] })
      scanTimer = setInterval(async () => {
        try {
          const codes = await detector.detect(v)
          if (codes.length) {
            const raw = codes[0].rawValue
            // Debounce: the same ticket sits in frame for many detect cycles.
            if (raw === lastCode && Date.now() - lastCodeAt < 4000) return
            lastCode = raw; lastCodeAt = Date.now()
            if (navigator.vibrate) navigator.vibrate(60)
            lookup(raw)
          }
        } catch { /* a failed frame is not an error state */ }
      }, 350)
    } catch (e) {
      toast(`Camera unavailable: ${e.message}`, true)
    }
  })

  const form = $('#scan-form')
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const code = $('#scan-input').value.trim()
    if (code) lookup(code)
  })

  on($('#view'), '[data-advance]', async (e) => {
    const btn = e.target.closest('[data-advance]')
    const jobId = Number(btn.dataset.job)
    const stage = btn.dataset.advance
    btn.disabled = true
    try {
      const d = await api.post('/api/scan', { job_id: jobId, to_stage: stage })
      if (navigator.vibrate) navigator.vibrate([40, 40, 40])
      renderJob(d, `Moved to ${d.stage_label}`)
    } catch (err) { toast(err.message, true); btn.disabled = false }
  })
}

async function lookup(code) {
  try {
    const d = await api.get(`/api/scan/${encodeURIComponent(code)}`)
    renderJob(d)
  } catch (e) { toast(e.message, true) }
}

function renderJob(d, note) {
  const mins = d.minutes_in_production
  const stageBtns = d.stages.map((s) => s.key === d.stage
    ? `<span class="scan-stage cur">${esc(s.label)}</span>`
    : `<button class="scan-stage" data-advance="${esc(s.key)}" data-job="${d.id}">${esc(s.label)}</button>`).join('')
  $('#scan-job').innerHTML = `
    <div class="card scan-job-card">
      ${note ? `<div class="scan-done">✓ ${esc(note)}</div>` : ''}
      <div class="scan-job-head">
        <div>
          <div class="scan-num">${esc(d.job_number)} ${d.rush ? '<span class="pill red">RUSH</span>' : ''}</div>
          <h2>${esc(d.title || '')}</h2>
          <div class="dim">${esc(d.contact_name)} · ${d.pieces} pcs${d.decoration ? ` · ${esc(d.decoration)}` : ''}${d.due_date ? ` · due ${esc(d.due_date)}` : ''}</div>
        </div>
      </div>
      ${d.next_stage ? `<button class="btn primary scan-advance" data-advance="${esc(d.next_stage.key)}" data-job="${d.id}">Advance to ${esc(d.next_stage.label)} →</button>` : '<div class="scan-done">✓ Complete</div>'}
      <div class="scan-stages">${stageBtns}</div>
      ${mins > 0 ? `<div class="dim" style="margin-top:10px">⏱ ${mins} min measured in production${d.stage === 'production' ? ' so far' : ''}</div>` : ''}
      ${d.scans.length ? `<div class="scan-log">${d.scans.map((s) => `<div class="dim">${esc(s.to_stage.replace('_', ' '))} — ${esc(s.actor || '')} · ${esc(String(s.created_at).slice(5, 16))}</div>`).join('')}</div>` : ''}
    </div>`
  $('#scan-job').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function stopCamera() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = 0 }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null }
}
