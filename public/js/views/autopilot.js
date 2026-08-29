import { api, $, $$, esc, money, setPage, toast, go, on } from '../core.js'

/**
 * Autopilot — the front office running itself.
 *
 * A customer email goes in; a paid job with a mockup comes out. The server does the record
 * chain atomically (/api/autopilot); the client narrates it as an animated pipeline and adds
 * the two visual steps that have to happen in canvas: pull/synthesize the art and build the
 * garment mockup. The point Cole wants made: the shop becomes "just a printer."
 */

const SAMPLE = `From: Dana Wu <dana@example.org>
Subject: Team hoodies

Hey! Our robotics team needs hoodies for the regional competition.

48 total — 6 S, 14 M, 16 L, 8 XL, 4 2XL.
Gildan 18500 in navy. Two color front (our logo) and a one color back.

Competition is in about two weeks. What's the damage?

Thanks,
Dana`

const STEPS = [
  { key: 'read', ico: '✉', title: 'Read the email', phase: 1 },
  { key: 'customer', ico: '◉', title: 'Log the customer', phase: 1 },
  { key: 'estimate', ico: '▤', title: 'Draft the estimate', phase: 1 },
  { key: 'art', ico: '◈', title: 'Pull the artwork', phase: 1 },
  { key: 'mockup', ico: '▧', title: 'Build the mockup', phase: 1 },
  // Phase 2 — the one irreversible, customer-facing step. In Review mode it waits for a human.
  //
  // This used to be three: "Send & approve", "Collect the deposit", "Onto the floor" — and the
  // screen ticked all three green. Autopilot stopped marking the estimate approved, raising the
  // invoice and pushing the job to prepress in v1.10.0, because doing any of that fabricated a
  // customer's consent. The server was fixed; the screen went on saying it had happened. The
  // shop was shown "$3,240 quoted & approved" and "$0.00 deposit collected" over a database
  // holding a sent estimate, approved_at NULL, no invoice, no payment, and a job still at 'new'.
  { key: 'sent', ico: '✓', title: 'Send to the customer', phase: 2 },
]

let uploadedArt = null
let mode = localStorage.getItem('psc-ap-mode') || 'review' // conservative default

export async function autopilotView() {
  setPage('Autopilot')
  $('#view').innerHTML = `
    <div class="ap">
      <div class="ap-hero">
        <div class="ap-badge">◆ AUTOPILOT</div>
        <h1>Your front office, running itself.</h1>
        <p>Paste a customer email. Watch it become a quote, a payment, a mockup, and a job on the floor — with nobody touching it. The shop's only job left is to print.</p>
      </div>

      <div class="ap-grid">
        <div class="card ap-input">
          <div class="card-h"><h3>Inbound email</h3><div class="spacer"></div>
            <button class="btn ghost sm" id="ap-sample">Use a sample</button></div>
          <div class="card-b">
            <div class="grid2">
              <div class="field"><label>From (name)</label><input class="input" id="ap-name" placeholder="Dana Wu"></div>
              <div class="field"><label>Email</label><input class="input" id="ap-email" placeholder="dana@example.org"></div>
            </div>
            <div class="field"><label>The message</label>
              <textarea class="input" id="ap-text" style="min-height:200px;font-size:13px" placeholder="Paste what the customer sent…"></textarea></div>
            <div class="field"><label>Artwork (optional — otherwise we synthesize one)</label>
              <div class="drop" id="ap-drop" style="padding:14px">Drop the logo they attached, or leave it — Autopilot makes a placeholder</div>
              <input type="file" id="ap-file" accept="image/*" hidden></div>
            <div class="field" style="margin-bottom:0"><label>How far should it go?</label>
              <div class="ap-dial" id="ap-dial">
                <button data-mode="review" class="${mode === 'review' ? 'on' : ''}">
                  <strong>Review first</strong><span>Drafts the quote &amp; mockup, then stops for you to send</span></button>
                <button data-mode="auto" class="${mode === 'auto' ? 'on' : ''}">
                  <strong>Full auto</strong><span>Sends the estimate for you — the customer approves, nothing is charged</span></button>
              </div>
            </div>
          </div>
        </div>

        <div class="card ap-runner">
          <div class="card-b" id="ap-stage">
            <div class="ap-empty">
              <div class="ap-orbit"><span>◆</span></div>
              <p>Ready when you are.</p>
              <button class="btn ap-go" id="ap-run">Run Autopilot →</button>
            </div>
          </div>
        </div>
      </div>
    </div>`

  $('#ap-sample').onclick = () => {
    $('#ap-text').value = SAMPLE.split('\n').slice(4).join('\n').trim()
    $('#ap-name').value = 'Dana Wu'; $('#ap-email').value = 'dana@example.org'
  }
  const fileEl = $('#ap-file'); const drop = $('#ap-drop')
  drop.onclick = () => fileEl.click()
  fileEl.onchange = (e) => { const f = e.target.files[0]; if (f) { uploadedArt = URL.createObjectURL(f); drop.textContent = `✓ ${f.name}` } }
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over') }
  drop.ondragleave = () => drop.classList.remove('over')
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) { uploadedArt = URL.createObjectURL(f); drop.textContent = `✓ ${f.name}` } }
  on($('#ap-dial'), '[data-mode]', (_e, t) => {
    mode = t.dataset.mode; localStorage.setItem('psc-ap-mode', mode)
    $$('#ap-dial button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode))
  })
  $('#ap-run').onclick = run
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const text = $('#ap-text').value.trim()
  if (text.length < 8) return toast('Paste the customer email first', true)

  // Draw the pipeline skeleton, then light each node as it completes.
  $('#ap-stage').innerHTML = `<div class="ap-pipe">
    <div class="ap-spine"><div class="ap-spine-fill" id="ap-fill"></div></div>
    <div class="ap-steps" id="ap-steps">${STEPS.map((s, i) => `
      <div class="ap-step" data-k="${s.key}" id="ap-step-${s.key}">
        <div class="ap-node"><span class="ap-ico">${s.ico}</span><span class="ap-check">✓</span></div>
        <div class="ap-body"><div class="ap-title">${s.title}</div><div class="ap-detail" id="ap-d-${s.key}"></div></div>
      </div>`).join('')}</div>
  </div>`

  const activate = (key) => { $(`#ap-step-${key}`)?.classList.add('active') }
  const complete = (key, detail) => {
    const el = $(`#ap-step-${key}`); if (!el) return
    el.classList.remove('active'); el.classList.add('done')
    if (detail) $(`#ap-d-${key}`).textContent = detail
    const idx = STEPS.findIndex((s) => s.key === key)
    $('#ap-fill').style.height = `${((idx + 1) / STEPS.length) * 100}%`
  }

  try {
    activate('read'); await sleep(450)
    const r = await api.post('/api/autopilot', { text, contact_name: $('#ap-name').value, contact_email: $('#ap-email').value, mode })
    const detailOf = (k) => r.steps.find((s) => s.key === k)?.detail || ''

    // Phase 1 always runs — read, customer, draft estimate.
    for (const k of ['read', 'customer', 'estimate']) { activate(k); await sleep(400); complete(k, detailOf(k)) }

    // Art + mockup — client-side, attach to the job that now exists.
    activate('art'); await sleep(300)
    const artUrl = uploadedArt || synthArt(r.order, $('#ap-name').value)
    const artImg = await loadImg(artUrl)
    complete('art', uploadedArt ? 'Pulled from the attachment' : 'Synthesized from the order')

    activate('mockup'); await sleep(300)
    const garment = garmentFor(r.order)
    const mockCanvas = renderMockup(artImg, garment.hex)
    const mockUrl = mockCanvas.toDataURL('image/png')
    const blob = await new Promise((res) => mockCanvas.toBlob(res, 'image/png'))
    const fd = new FormData(); fd.append('file', blob, `${r.job.job_number}-mockup.png`); fd.append('notes', 'Auto-generated by Autopilot')
    await api.req('POST', `/api/jobs/${r.job.id}/art`, fd)
    complete('mockup', `${garment.name} garment · proof attached`)

    if (r.mode === 'review') {
      await sleep(300)
      return reviewReveal(r, mockUrl) // stop here — the human decides
    }

    // Full auto — the server already fired phase 2; narrate exactly what it says it did.
    activate('sent'); await sleep(400); complete('sent', detailOf('sent'))
    await sleep(300)
    doneReveal(r, mockUrl)
  } catch (e) {
    toast(e.message, true)
    $('#ap-stage').innerHTML += `<div class="ap-err">${esc(e.message)}</div>`
  }
}

/** Review mode: the editable draft, waiting for a human to send it (or not). The manual gate. */
function reviewReveal(r, mockUrl) {
  $('#ap-stage').innerHTML = `<div class="ap-reveal">
    <div class="ap-mockup"><img src="${mockUrl}" alt="mockup"></div>
    <div class="ap-review-h">${r.held_for_review?.length ? 'Held for your call' : 'Draft ready for your call'}</div>
    ${r.ai_note ? `<p class="ap-review-note ap-held">${esc(r.ai_note)}</p>` : ''}
    <div class="ap-stats">
      <div><span>${money(r.estimate.total)}</span><em>quoted (not sent)</em></div>
      <div><span>${r.job.job_number}</span><em>job drafted</em></div>
    </div>
    <p class="ap-review-note">Nothing has gone to the customer and nothing's been charged. Edit anything, then send — or leave it as a draft.</p>
    ${r.held_for_review?.length ? `<p class="ap-review-note">Full auto was on, so this would have been sent unread. It stopped here because the assistant and the email disagree on <strong>${esc(r.held_for_review.join(', '))}</strong>.</p>` : ''}
    <div class="ap-links">
      <button class="btn" id="ap-commit">Send it to the customer →</button>
      <a class="btn ghost" href="#/estimates/${r.estimate.id}/edit">Edit the estimate</a>
      <a class="btn ghost" href="#/jobs/${r.job.id}">Open the job</a>
      <button class="btn ghost" id="ap-again">Run another</button>
    </div>
    <p class="ap-foot">Customer <strong>${esc(r.contact.name)}</strong> and estimate <strong>${esc(r.estimate.estimate_number)}</strong> exist as a <strong>draft</strong>. This is the conservative default — flip to Full auto to skip this gate once you trust it.</p>
  </div>`
  $('#ap-again').onclick = autopilotView
  $('#ap-commit').onclick = async () => {
    const btn = $('#ap-commit'); btn.disabled = true; btn.textContent = 'Sending…'
    try {
      const c = await api.post('/api/autopilot/commit', { estimate_id: r.estimate.id })
      doneReveal({ ...r, estimate: c.estimate, invoice: c.invoice, job: c.job || r.job }, mockUrl)
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Send it to the customer →' }
  }
}

/**
 * What actually happened, read off the record rather than assumed.
 *
 * This screen used to report "quoted & approved", "$0.00 deposit collected" and "on the floor"
 * over a database holding a sent estimate with approved_at NULL, zero invoices, zero payments and
 * a job still at stage 'new' — because the server stopped doing those three things in v1.10.0
 * (they fabricated a consent the customer had never given) and the screen was never told. The
 * shop believed money had been collected on an order the customer had not yet answered.
 *
 * Every figure below is now conditional on the row it describes existing.
 */
function doneReveal(r, mockUrl) {
  const approved = r.estimate?.status === 'approved'
  const paid = Number(r.invoice?.amount_paid) || 0
  $('#ap-stage').innerHTML = `<div class="ap-reveal">
    <div class="ap-mockup"><img src="${mockUrl}" alt="mockup"></div>
    <div class="ap-done-h">${approved ? 'Approved. The shop just prints.' : 'Sent. Waiting on the customer.'}</div>
    <div class="ap-stats">
      <div><span>${money(r.estimate.total)}</span><em>quoted &amp; ${approved ? 'approved' : 'sent'}</em></div>
      ${r.invoice ? `<div><span>${money(paid)}</span><em>${paid > 0 ? 'collected' : 'invoiced, unpaid'}</em></div>` : ''}
      <div><span>${r.job.job_number}</span><em>${approved ? 'on the floor' : 'drafted, not started'}</em></div>
    </div>
    <div class="ap-links">
      <a class="btn" href="#/jobs/${r.job.id}">Open the job →</a>
      ${r.invoice ? `<a class="btn ghost" href="#/invoices/${r.invoice.id}">Invoice</a>` : ''}
      <a class="btn ghost" href="#/conversations/${r.contact.id}">Conversation</a>
      <button class="btn ghost" id="ap-again">Run another</button>
    </div>
    <p class="ap-foot">Customer <strong>${esc(r.contact.name)}</strong>, estimate <strong>${esc(r.estimate.estimate_number)}</strong>${r.invoice ? `, invoice <strong>${esc(r.invoice.invoice_number)}</strong>` : ''} and job <strong>${esc(r.job.job_number)}</strong> now exist.
      ${approved ? '' : 'Nothing is approved and nothing has been charged — that happens when the customer clicks Approve on the link they were just sent.'}</p>
  </div>`
  $('#ap-again').onclick = autopilotView
}

/* ---------- art + mockup ---------- */

/* ---------- garment swatches for the mockup ----------
 * These used to live in the separations module. Only the mockup needs them, so they moved here
 * when that tool was removed rather than keeping a shared file alive for two constants. */
const GARMENT_COLORS = [
  { name: 'White', hex: '#f4f4f4', dark: false },
  { name: 'Black', hex: '#151515', dark: true },
  { name: 'Navy', hex: '#1b2a44', dark: true },
  { name: 'Heather', hex: '#9aa0a6', dark: false },
  { name: 'Red', hex: '#7a1f24', dark: true },
  { name: 'Sand', hex: '#d8cbb0', dark: false },
]

function hexToRgb(hex) {
  const h = String(hex).replace('#', '')
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)]
}

// Map the parsed garment color onto a swatch the mockup can render (with a few synonyms).
const COLOR_MAP = { navy: 'Navy', royal: 'Navy', black: 'Black', charcoal: 'Black', forest: 'Navy',
  white: 'White', heather: 'Heather', gray: 'Heather', grey: 'Heather', sand: 'Sand', red: 'Red', maroon: 'Red' }
const garmentFor = (order) => {
  const name = COLOR_MAP[order.garment_color] || (order.dark_garment ? 'Black' : 'White')
  return GARMENT_COLORS.find((g) => g.name === name) || GARMENT_COLORS[0]
}

const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src })

/** A clean generative emblem when no art was attached — initials in a ringed badge. */
function synthArt(order, name) {
  const c = document.createElement('canvas'); c.width = 480; c.height = 480
  const x = c.getContext('2d')
  const inks = (order.locations?.[0]?.colors >= 2) ? ['#f5d21e', '#e23b3b', '#1e46aa'] : ['#f5f5f5', '#1e46aa']
  x.fillStyle = inks[0]; x.beginPath(); x.arc(240, 240, 175, 0, 7); x.fill()
  x.strokeStyle = inks[1]; x.lineWidth = 16; x.beginPath(); x.arc(240, 240, 150, 0, 7); x.stroke()
  const initials = String(name || 'INK').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'INK'
  x.fillStyle = inks[inks.length - 1]; x.font = '900 150px Impact, Haettenschweiler, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'
  x.fillText(initials, 240, 235)
  x.fillStyle = inks[1]; x.font = '700 34px Georgia, serif'; x.fillText('EST. 2026', 240, 350)
  return c.toDataURL('image/png')
}

/** Composite the art onto a t-shirt silhouette with fabric shading — a real proof mockup. */
function renderMockup(artImg, garmentHex) {
  const W = 620, H = 640
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const x = c.getContext('2d')
  x.clearRect(0, 0, W, H)

  const shirt = new Path2D('M310,40 L215,80 L120,120 L60,210 L120,255 L165,225 L165,600 L455,600 L455,225 L500,255 L560,210 L500,120 L405,80 L310,40 Z')
  // fabric: base color + soft vertical light
  const g = x.createLinearGradient(0, 40, 0, 600)
  const [r, gg, b] = hexToRgb(garmentHex)
  const lighten = (v, a) => Math.min(255, v + a)
  g.addColorStop(0, `rgb(${lighten(r, 22)},${lighten(gg, 22)},${lighten(b, 22)})`)
  g.addColorStop(.5, garmentHex)
  g.addColorStop(1, `rgb(${Math.max(0, r - 18)},${Math.max(0, gg - 18)},${Math.max(0, b - 18)})`)
  x.save(); x.fillStyle = g; x.fill(shirt)
  // collar shadow
  x.clip(shirt)
  x.strokeStyle = 'rgba(0,0,0,.22)'; x.lineWidth = 10
  x.beginPath(); x.arc(310, 55, 58, 0.15 * Math.PI, 0.85 * Math.PI); x.stroke()
  // subtle side shading for form
  const sh = x.createLinearGradient(120, 0, 500, 0)
  sh.addColorStop(0, 'rgba(0,0,0,.18)'); sh.addColorStop(.2, 'rgba(0,0,0,0)'); sh.addColorStop(.8, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,.18)')
  x.fillStyle = sh; x.fill(shirt)
  x.restore()

  // art in the print area (chest)
  const boxW = 250, boxH = 250, bx = (W - boxW) / 2, by = 180
  const ar = artImg.width / artImg.height
  let dw = boxW, dh = boxW / ar
  if (dh > boxH) { dh = boxH; dw = boxH * ar }
  x.globalAlpha = 0.96
  x.drawImage(artImg, bx + (boxW - dw) / 2, by + (boxH - dh) / 2, dw, dh)
  x.globalAlpha = 1
  return c
}

