import { api, $, esc, setPage, on, toast, onOnce, fmtDate, relTime, announce } from '../core.js'

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

// The camera has to go off when the page does.
//
// stopCamera() was only ever called at the TOP of scanView() — on re-entry. Walk away from Floor
// Mode and the phone kept the camera live: the indicator light stays on, the battery drains, and
// on iOS and Android the camera is held away from every other app until the tab is closed. The
// 350ms detect loop kept running too, and its lookup() would render into a #scan-job that no
// longer exists, popping "Cannot set properties of null" onto whatever page you had moved to.
//
// hashchange is this app's navigation (see public/js/app.js), and pagehide covers tab close,
// bfcache and a real navigation away. Registered once, not per view render.
if (typeof window !== 'undefined' && !window.__pscScanTeardown) {
  window.__pscScanTeardown = true
  const leaving = () => { if (!location.hash.startsWith('#/scan')) stopCamera() }
  window.addEventListener('hashchange', leaving)
  window.addEventListener('pagehide', () => stopCamera())
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stopCamera() })
}

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
        ${hasDetector ? '<button class="btn" id="scan-start">Start camera</button><button class="btn ghost" id="scan-stop" hidden>Stop camera</button>' : ''}
      </div>
      <form id="scan-form" class="scan-form" autocomplete="off">
        <input id="scan-input" name="code" inputmode="text" placeholder="Job number — e.g. JOB-1042" autofocus />
        <button class="btn primary" type="submit">Find job</button>
      </form>
      <div id="scan-job"></div>
    </div>`

  onOnce($('#view'), '#scan-start', async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      const v = $('#scan-video')
      v.srcObject = stream
      v.style.display = 'block'
      $('#scan-cam-hint').textContent = 'Scanning…'
      $('#scan-start').hidden = true
      $('#scan-stop').hidden = false
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
      stopCamera()
      toast(`Camera unavailable: ${e.message}`, true)
    }
  })

  // Without this the only way to switch the camera off while still on the page was to reload it.
  onOnce($('#view'), '#scan-stop', () => {
    stopCamera()
    const hint = $('#scan-cam-hint')
    if (hint) hint.textContent = '📷 Point the camera at a work-ticket barcode.'
  })

  const form = $('#scan-form')
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const code = $('#scan-input').value.trim()
    if (code) lookup(code)
  })

  onOnce($('#view'), '[data-advance]', async (e) => {
    const btn = e.target.closest('[data-advance]')
    /* data-scanjob, not data-job.
     *
     * Four screens — capacity.js, roi.js, misc.js and dashboard.js — delegate `[data-job]` on
     * #view, the app shell's permanent <main>, with onOnce, which never unbinds. Floor Mode's
     * stage buttons carried BOTH data-advance and data-job, so once the shop had opened
     * Profitability, Capacity or Art in that tab, one tap on the floor tablet fired the scan POST
     * *and* go('/jobs/<id>'). By the time the POST came back, renderJob()'s own guard
     * (`const host = $('#scan-job'); if (!host) return`) short-circuited on the job page that had
     * replaced the screen: no confirmation card, no announce(), no focus move.
     *
     * So the stage advanced and the operator was told nothing — on the one screen whose taps are
     * the labour timestamps Profitability is computed from, in front of someone holding a garment.
     * The natural next move is to tap it again. */
    const jobId = Number(btn.dataset.scanjob)
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
  // A detect cycle can land after the view is gone; there is nothing to draw into then.
  const host = $('#scan-job')
  if (!host) return
  const mins = d.minutes_in_production
  const stageBtns = d.stages.map((s) => s.key === d.stage
    ? `<span class="scan-stage cur">${esc(s.label)}</span>`
    : `<button class="scan-stage" data-advance="${esc(s.key)}" data-scanjob="${d.id}">${esc(s.label)}</button>`).join('')
  host.innerHTML = `
    <div class="card scan-job-card">
      <div class="scan-done-wrap" role="status" aria-live="polite" aria-atomic="true">${note ? `<div class="scan-done">✓ ${esc(note)}</div>` : ''}</div>
      <div class="scan-job-head">
        <div>
          <div class="scan-num">${esc(d.job_number)} ${d.rush ? '<span class="pill red">RUSH</span>' : ''}</div>
          <h2>${esc(d.title || '')}</h2>
          <div class="dim">${esc(d.contact_name)} · ${d.pieces} pcs${d.decoration ? ` · ${esc(d.decoration)}` : ''}${d.due_date ? ` · due ${esc(fmtDate(d.due_date))}` : ''}</div>
        </div>
      </div>
      ${d.next_stage ? `<button class="btn primary scan-advance" data-advance="${esc(d.next_stage.key)}" data-scanjob="${d.id}">Advance to ${esc(d.next_stage.label)} →</button>` : '<div class="scan-done">✓ Complete</div>'}
      <div class="scan-stages">${stageBtns}</div>
      ${mins > 0 ? `<div class="dim" style="margin-top:10px">⏱ ${mins} min measured in production${d.stage === 'production' ? ' so far' : ''}</div>` : ''}
      ${d.scans.length ? `<div class="scan-log">${d.scans.map((s) => `<div class="dim">${esc(s.to_stage.replace('_', ' '))} — ${esc(s.actor || '')} · ${esc(relTime(s.created_at))}</div>`).join('')}</div>` : ''}
    </div>`
  host.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // Floor Mode is a phone page used one-handed on the shop floor, and every tap here stamps a
  // labour timestamp the profitability report is built from, with no undo. It confirmed the scan
  // by swapping this whole block's innerHTML — visible if you can see it, and completely silent
  // otherwise. A press operator using VoiceOver tapped "Advance to Production" and heard nothing:
  // no confirmation, no new stage, no error. The only safe thing to do is tap it again.
  announce(note
    ? `${note}. ${d.job_number}, ${d.title || ''}.`
    : `${d.job_number}, ${d.title || ''}, ${d.contact_name}, ${d.pieces} pieces, currently ${d.stage.replace('_', ' ')}.`)
  // …and the innerHTML above just destroyed the button that was pressed, so focus fell to <body>
  // and the next tab started from the top of the page. Put it on the control that does the next
  // thing — the same control the thumb is already over.
  ;($('.scan-advance', host) || $('button.scan-stage', host))?.focus?.()
}

function stopCamera() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = 0 }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null }
  lastCode = ''; lastCodeAt = 0
  const v = $('#scan-video')
  if (v) { v.srcObject = null; v.style.display = 'none' }
  const start = $('#scan-start'); if (start) start.hidden = false
  const stop = $('#scan-stop'); if (stop) stop.hidden = true
}
