import { api, $, $$, esc, money, setPage, toast, on, go } from '../core.js'
import * as S from '../shared/separations.js'
import { quoteScreenPrint } from '../shared/pricing.js'

/**
 * Separation Studio — split artwork into printable screens, right inside the shop tool.
 *
 * No competitor bundles this; shops pay for a separate product (Separation Studio, Spot
 * Process, UltraSeps) and re-key the screen count into their quoting tool by hand. Here the
 * separation IS the screen count, and the screen count IS the price. All client-side canvas.
 */

const MAX = 520 // cap the working resolution so the sliders stay live

let state = null

export async function sepsView() {
  setPage('Separation Studio', `<button class="btn ghost" id="sep-sample">Load sample art</button><button class="btn" id="sep-upload-btn">Upload art</button>`)
  const settings = (await api.get('/api/settings')).settings

  $('#view').innerHTML = `
    <input type="file" id="sep-file" accept="image/*" hidden>
    <div class="sepwrap">
      <div class="sep-left">
        <div class="card"><div class="card-b" id="sep-stage">
          <div class="sep-drop" id="sep-drop">
            <div style="font-size:30px;opacity:.5">◑</div>
            <p style="margin:8px 0 3px;font-weight:600">Drop artwork here</p>
            <p class="dim" style="font-size:12px">PNG or JPG · logos and spot-color art separate best</p>
            <button class="btn ghost sm" id="sep-sample2" style="margin-top:12px">Try a sample</button>
          </div>
        </div></div>
      </div>
      <div class="sep-right">
        <div class="card"><div class="card-b" id="sep-controls">
          <div class="dim" style="font-size:12.5px;text-align:center;padding:20px 0">Load art to separate it into screens.</div>
        </div></div>
      </div>
    </div>`

  const openFile = () => $('#sep-file').click()
  $('#sep-upload-btn').onclick = openFile
  $('#sep-drop').onclick = openFile
  $('#sep-file').onchange = (e) => { if (e.target.files[0]) loadImage(URL.createObjectURL(e.target.files[0]), settings) }
  $('#sep-sample').onclick = () => loadImage(sampleArt(), settings)
  $('#sep-sample2').onclick = () => loadImage(sampleArt(), settings)

  const drop = $('#sep-drop')
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over') }
  drop.ondragleave = () => drop.classList.remove('over')
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadImage(URL.createObjectURL(f), settings) }

  // Coming from a job's art proof: ?art=/uploads/xxx&job=NN
  const params = new URLSearchParams(location.hash.split('?')[1] || '')
  fromJob = params.get('job') ? { id: +params.get('job') } : null
  if (params.get('art')) loadImage(params.get('art'), settings)
}

let fromJob = null

function loadImage(src, settings) {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    const scale = Math.min(1, MAX / Math.max(img.width, img.height))
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, w, h)
    const imageData = ctx.getImageData(0, 0, w, h)
    state = { imageData, w, h, mode: 'spot', k: 4, garment: 'Black', softness: 90, settings, palette: null }
    recompute()
    renderControls()
  }
  img.onerror = () => toast('Could not load that image', true)
  img.src = src
}

function recompute() {
  const s = state
  const dark = S.GARMENT_COLORS.find((g) => g.name === s.garment)?.dark
  if (s.mode === 'spot') {
    s.palette = s.palette && s.palette.length === s.k ? s.palette : S.quantize(s.imageData, s.k)
    s.inks = s.palette.map((p) => ({ name: S.inkName(p.rgb), rgb: p.rgb, hex: p.hex }))
  } else {
    s.inks = S.SIM_PROCESS_INKS.map((i) => ({ ...i, hex: S.rgbToHex(i.rgb) }))
  }
  s.sep = S.separate(s.imageData, s.inks, { softness: s.softness })
  s.ub = dark ? S.underbase(s.sep, s.inks) : null
  s.screens = S.screenCount(s.inks, dark)
  s.dark = dark
}

function garmentHex() { return S.GARMENT_COLORS.find((g) => g.name === state.garment)?.hex || '#151515' }

/** Render one channel's coverage as ink over the garment color. */
function channelCanvas(coverage, ink, { film = false } = {}) {
  if (film) return filmType === 'halftone' ? halftoneCanvas(coverage, ink) : ditherCanvas(coverage, filmType)
  const { w, h } = state
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const ctx = c.getContext('2d')
  const out = ctx.createImageData(w, h)
  const bg = S.hexToRgb(garmentHex())
  const fg = ink.rgb
  for (let i = 0; i < w * h; i++) {
    const t = coverage[i] / 255
    const o = i * 4
    out.data[o] = bg[0] + (fg[0] - bg[0]) * t
    out.data[o + 1] = bg[1] + (fg[1] - bg[1]) * t
    out.data[o + 2] = bg[2] + (fg[2] - bg[2]) * t
    out.data[o + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
  return c
}

/**
 * A real film positive: halftone dots, black on white, so the screen can be exposed. Dot
 * size tracks ink coverage in each cell — that's how a printer gets shading from one screen.
 * The 22.5° angle is the standard single-screen angle that avoids moiré on press.
 */
function halftoneCanvas(coverage, _ink, { cell = 6, angle = 22.5 } = {}) {
  const { w, h } = state
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#111'
  const rad = angle * Math.PI / 180
  const cos = Math.cos(rad), sin = Math.sin(rad)
  const diag = Math.ceil(Math.hypot(w, h))
  const avg = (cx, cy) => {
    let sum = 0, n = 0
    for (let y = cy - cell / 2; y < cy + cell / 2; y += 2) for (let x = cx - cell / 2; x < cx + cell / 2; x += 2) {
      const xi = Math.round(x), yi = Math.round(y)
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue
      sum += coverage[yi * w + xi]; n++
    }
    return n ? sum / n / 255 : 0
  }
  // Walk a grid rotated by `angle`, place a dot per cell sized by local coverage.
  for (let v = -diag; v < diag; v += cell) {
    for (let u = -diag; u < diag; u += cell) {
      const cx = u * cos - v * sin + w / 2
      const cy = u * sin + v * cos + h / 2
      if (cx < -cell || cy < -cell || cx > w + cell || cy > h + cell) continue
      const t = avg(cx, cy)
      if (t < 0.06) continue
      const r = (cell / 2) * Math.sqrt(Math.min(1, t)) * 1.05
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill()
    }
  }
  return c
}

/** Composite: garment color, underbase, then every ink stacked in print order. */
function compositeCanvas() {
  const { w, h, sep, ub, inks } = state
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const ctx = c.getContext('2d')
  const buf = new Float32Array(w * h * 3)
  const bg = S.hexToRgb(garmentHex())
  for (let i = 0; i < w * h; i++) { buf[i * 3] = bg[0]; buf[i * 3 + 1] = bg[1]; buf[i * 3 + 2] = bg[2] }
  const lay = (coverage, rgb) => {
    for (let i = 0; i < w * h; i++) {
      const t = coverage[i] / 255
      if (!t) continue
      buf[i * 3] = buf[i * 3] * (1 - t) + rgb[0] * t
      buf[i * 3 + 1] = buf[i * 3 + 1] * (1 - t) + rgb[1] * t
      buf[i * 3 + 2] = buf[i * 3 + 2] * (1 - t) + rgb[2] * t
    }
  }
  if (ub) lay(ub, [245, 245, 245])
  // Dark inks first, light on top — matches print order and reads cleaner.
  inks.map((ink, idx) => ({ ink, idx })).sort((a, b) => S.luminance(a.ink.rgb) - S.luminance(b.ink.rgb))
    .forEach(({ ink, idx }) => lay(sep.coverage[idx], ink.rgb))
  const out = ctx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) { out.data[i * 4] = buf[i * 3]; out.data[i * 4 + 1] = buf[i * 3 + 1]; out.data[i * 4 + 2] = buf[i * 3 + 2]; out.data[i * 4 + 3] = 255 }
  ctx.putImageData(out, 0, 0)
  return c
}

let filmMode = false
let filmType = 'halftone' // 'halftone' (AM dots) | 'diffusion' (Floyd–Steinberg FM) | 'bayer' (ordered FM)

// 8×8 Bayer threshold matrix (0..63) for ordered dithering.
const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
]

/**
 * A DITHERED film positive — stochastic (FM) screening instead of AM halftone dots. Ink is placed
 * as a scatter of 1-px marks whose density tracks coverage. Dithered seps hold gradients and
 * distressed art far better than AM dots and are much more forgiving of imperfect registration and
 * low mesh — the same technique paid Photoshop plugins (DitherTone etc.) sell, built in here.
 *   'diffusion' = Floyd–Steinberg error diffusion (smoothest, organic)
 *   'bayer'     = ordered 8×8 (crisp, repeatable, RIP-friendly)
 */
function ditherCanvas(coverage, method = 'diffusion') {
  const { w, h } = state
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(w, h)
  const d = img.data
  if (method === 'bayer') {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x
      const ink = coverage[i] / 255 > (BAYER8[y & 7][x & 7] + 0.5) / 64
      const v = ink ? 0 : 255 // ink prints black on the film
      const o = i * 4; d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
    }
  } else {
    const buf = Float32Array.from(coverage) // ink demand 0..255, diffused as we go
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x
      const ink = buf[i] >= 127
      const err = buf[i] - (ink ? 255 : 0)
      if (x + 1 < w) buf[i + 1] += err * 7 / 16
      if (y + 1 < h) { if (x > 0) buf[i + w - 1] += err * 3 / 16; buf[i + w] += err * 5 / 16; if (x + 1 < w) buf[i + w + 1] += err * 1 / 16 }
      const v = ink ? 0 : 255
      const o = i * 4; d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}

function renderStage() {
  const stage = $('#sep-stage')
  stage.innerHTML = `<div class="sep-composite"><div class="sep-lbl">Simulated print · ${esc(state.garment)}</div></div>
    <div class="sep-screens" id="sep-screens"></div>`
  const comp = compositeCanvas()
  comp.className = 'sep-canvas'
  $('.sep-composite', stage).appendChild(comp)

  const strip = $('#sep-screens')
  const chips = []
  if (state.ub) chips.push({ label: 'Underbase', sub: 'White · prints first', cov: state.ub, ink: { rgb: [245, 245, 245], hex: '#f5f5f5', name: 'White' } })
  state.inks.forEach((ink, i) => chips.push({ label: ink.name, sub: ink.hex, cov: state.sep.coverage[i], ink }))

  strip.innerHTML = chips.map((_, i) => `<div class="sep-screen" data-screen="${i}">
      <div class="sep-thumb" id="sep-thumb-${i}"></div>
      <div class="sep-screen-meta"><span class="sw" style="background:${esc(chips[i].ink.hex)}"></span>
        <div><div class="sep-screen-name">${esc(chips[i].label)}</div><div class="dim" style="font-size:10px">${esc(chips[i].sub)}</div></div></div>
    </div>`).join('')
  chips.forEach((ch, i) => $(`#sep-thumb-${i}`).appendChild(Object.assign(channelCanvas(ch.cov, ch.ink, { film: filmMode }), { className: 'sep-canvas' })))
}

function renderControls() {
  renderStage()
  const s = state
  const dark = s.dark
  const q = quoteScreenPrint({
    garmentCost: 3.2, markup: Number(s.settings.default_markup) || 2, qty: 48,
    locations: [{ name: 'Front', colors: s.inks.length }], screenFee: Number(s.settings.screen_fee) || 25, darkGarment: dark,
  })

  $('#sep-controls').innerHTML = `
    <div class="sep-count">
      <div class="sep-count-num">${s.screens}</div>
      <div><div style="font-weight:600">screen${s.screens === 1 ? '' : 's'}</div>
        <div class="dim" style="font-size:11.5px">${s.inks.length} ink${s.inks.length === 1 ? '' : 's'}${dark ? ' + white underbase' : ''}</div></div>
    </div>

    <div class="field" style="margin-top:14px"><label>Separation mode</label>
      <div class="tabs" id="sep-mode">
        <button data-m="spot" class="${s.mode === 'spot' ? 'on' : ''}">Spot color</button>
        <button data-m="process" class="${s.mode === 'process' ? 'on' : ''}">Sim process</button>
      </div>
    </div>

    ${s.mode === 'spot' ? `<div class="field"><label>Colors — ${s.k}</label>
      <input type="range" id="sep-k" min="1" max="8" value="${s.k}" class="sep-range"></div>` : `<div class="dim" style="font-size:11.5px;margin-bottom:12px">Separating onto the 6 sim-process screens on your rack.</div>`}

    <div class="field"><label>Garment</label>
      <div class="sep-garments" id="sep-garment">
        ${S.GARMENT_COLORS.map((g) => `<button class="sep-gswatch ${g.name === s.garment ? 'on' : ''}" data-g="${g.name}" title="${g.name}" style="background:${g.hex}"></button>`).join('')}
      </div>
    </div>

    <div class="field"><label>Detail / halftone — ${s.softness}</label>
      <input type="range" id="sep-soft" min="40" max="160" value="${s.softness}" class="sep-range">
      <div class="dim" style="font-size:10.5px;margin-top:3px">Lower = tighter solids, higher = softer edges</div></div>

    ${s.mode === 'spot' && s.inks.length ? `<div class="field"><label>Inks — tap to recolor</label>
      <div class="sep-inks" id="sep-inks">${s.inks.map((ink, i) => `<label class="sep-ink"><input type="color" value="${ink.hex}" data-ink="${i}"><span>${esc(ink.name)}</span></label>`).join('')}</div></div>` : ''}

    <div class="sep-pricehint">
      <div class="row" style="justify-content:space-between"><span class="dim" style="font-size:12px">Est. at 48 pc</span><strong>${money(q.perPiece)}/pc</strong></div>
      <div class="row" style="justify-content:space-between"><span class="dim" style="font-size:12px">Screen fees</span><span>${money((Number(s.settings.screen_fee) || 25) * s.screens)}</span></div>
    </div>

    <div class="wrap-row" style="margin-top:14px">
      <button class="btn ghost sm" id="sep-film">${filmMode ? 'Show ink' : 'Film positives'}</button>
      <button class="btn ghost sm" id="sep-download">Download screens</button>
    </div>
    ${filmMode ? `<div class="field" style="margin-top:10px"><label>Film screening</label>
      <div class="tabs" id="sep-filmtype">
        <button data-ft="halftone" class="${filmType === 'halftone' ? 'on' : ''}">Halftone (AM)</button>
        <button data-ft="diffusion" class="${filmType === 'diffusion' ? 'on' : ''}">Dither (FM)</button>
        <button data-ft="bayer" class="${filmType === 'bayer' ? 'on' : ''}">Ordered</button>
      </div>
      <div class="dim" style="font-size:10.5px;margin-top:3px">Dither holds gradients & distressed art with no moiré — forgiving of low mesh and loose registration.</div></div>` : ''}
    <div class="wrap-row" style="margin-top:8px">
      ${fromJob ? `<button class="btn" id="sep-savejob" style="flex:1">Save to job</button>` : `<button class="btn" id="sep-quote" style="flex:1">Quote this →</button>`}
    </div>`

  on($('#sep-mode'), '[data-m]', (_e, t) => { s.mode = t.dataset.m; s.palette = null; recompute(); renderControls() })
  on($('#sep-garment'), '[data-g]', (_e, t) => { s.garment = t.dataset.g; recompute(); renderControls() })
  const kEl = $('#sep-k'); if (kEl) kEl.oninput = (e) => { s.k = +e.target.value; s.palette = null; recompute(); renderControls() }
  $('#sep-soft').oninput = (e) => { s.softness = +e.target.value; recompute(); renderStage(); $('#sep-controls .field label').textContent }
  $('#sep-soft').onchange = (e) => { s.softness = +e.target.value; recompute(); renderControls() }
  on($('#sep-inks') || document.createElement('div'), '[data-ink]', (_e, t) => {
    const i = +t.dataset.ink
    s.inks[i] = { ...s.inks[i], rgb: S.hexToRgb(t.value), hex: t.value, name: S.inkName(S.hexToRgb(t.value)) }
    s.palette[i] = { ...s.palette[i], rgb: S.hexToRgb(t.value), hex: t.value }
    recomputeFromInks(); renderStage()
  }, 'input')

  $('#sep-film').onclick = () => { filmMode = !filmMode; renderControls() } // re-render so the screening selector shows/hides
  $('#sep-download').onclick = downloadScreens
  $('#sep-quote')?.addEventListener('click', () => sendToQuote())
  $('#sep-savejob')?.addEventListener('click', saveToJob)
  // Bound last, and against a stand-in root: the screening selector only exists in film mode.
  on($('#sep-filmtype') || document.createElement('div'), '[data-ft]', (_e, t) => { filmType = t.dataset.ft; renderControls() })
}

async function saveToJob() {
  const s = state
  try {
    await api.post(`/api/jobs/${fromJob.id}/separation`, {
      colors: s.inks.length, screens: s.screens, dark: s.dark, garment: s.garment, mode: s.mode,
      inks: s.inks.map((i) => ({ name: i.name, hex: i.hex })),
    })
    toast(`${s.screens} screens saved to the job`)
    go(`/jobs/${fromJob.id}`)
  } catch (e) { toast(e.message, true) }
}

/** Re-run separation with the shop's manually recolored inks (skip re-quantizing). */
function recomputeFromInks() {
  const s = state
  s.sep = S.separate(s.imageData, s.inks, { softness: s.softness })
  s.ub = s.dark ? S.underbase(s.sep, s.inks) : null
  s.screens = S.screenCount(s.inks, s.dark)
}

function downloadScreens() {
  const chips = []
  if (state.ub) chips.push({ name: 'underbase', cov: state.ub, ink: { rgb: [245, 245, 245] } })
  state.inks.forEach((ink, i) => chips.push({ name: ink.name.toLowerCase().replace(/\s+/g, '-'), cov: state.sep.coverage[i], ink }))
  chips.forEach((ch, idx) => {
    const c = channelCanvas(ch.cov, ch.ink, { film: true }) // film positives are what goes to the imagesetter
    const a = document.createElement('a')
    a.href = c.toDataURL('image/png')
    a.download = `screen-${String(idx + 1).padStart(2, '0')}-${ch.name}.png`
    a.click()
  })
  toast(`Downloaded ${chips.length} film positive${chips.length === 1 ? '' : 's'}`)
}

/** Hand the separation result to a new estimate — the screen count drives the price. */
function sendToQuote() {
  const s = state
  sessionStorage.setItem('psc-sep', JSON.stringify({
    colors: s.inks.length, dark: s.dark, garment: s.garment, screens: s.screens,
    inks: s.inks.map((i) => ({ name: i.name, hex: i.hex })),
  }))
  toast(`${s.screens} screens → estimate`)
  go('/estimates/new?sep=1')
}

/** A generated sample so the tool demos with zero setup — a 3-color badge on transparent. */
function sampleArt() {
  const c = document.createElement('canvas'); c.width = 400; c.height = 400
  const x = c.getContext('2d')
  x.clearRect(0, 0, 400, 400)
  x.fillStyle = '#c81e28'; x.beginPath(); x.arc(200, 200, 150, 0, 7); x.fill()
  x.fillStyle = '#f5d21e'; x.beginPath(); x.arc(200, 200, 108, 0, 7); x.fill()
  x.fillStyle = '#1e46aa'; x.beginPath(); x.arc(200, 200, 66, 0, 7); x.fill()
  x.fillStyle = '#f5f5f5'; x.font = 'bold 42px Impact, sans-serif'; x.textAlign = 'center'
  x.fillText('REBEL', 200, 190); x.fillText('INK', 200, 234)
  return c.toDataURL('image/png')
}
