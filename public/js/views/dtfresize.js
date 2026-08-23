import { api, $, esc, money, setPage, toast, on } from '../core.js'
import { readPngDpi, addPngDpi, canvasToPngBlob, analyzeTrim, resizeToPrint, loadImage,
  printQuality, maxPrintSize, upscale, gangSheetLayout, gangSheetPrice, SHEET_SIZES, fitSheet } from '../shared/dtftrim.js'

/**
 * DTF Resize — auto-trim a transparent PNG and resample it to exact print size with real DPI
 * metadata. The everyday prep step before art hits the gang sheet or the RIP. Entirely in the
 * browser: the art never uploads anywhere.
 */

let st = null
const reset = () => { st = { img: null, file: null, url: null, srcDpi: null, crop: null, outUrl: null, outName: null, upUrl: null } }

export async function dtfResizeView() {
  reset()
  const lite = window.__EDITION === 'lite'
  setPage(lite ? 'Art Tools' : 'DTF Resize', '', lite ? '' : '<span class="dim">Production</span>')
  // The planner quotes off the shop's own roll rate, so the number it shows is the number it charges.
  const cfg = (await api.get('/api/settings').catch(() => ({ settings: {} }))).settings || {}
  const rollW = Number(cfg.dtf_sheet_width) || 22
  const perInch = Number(cfg.dtf_price_per_inch) || 0.95
  const minChg = Number(cfg.dtf_min_charge) || 10
  $('#view').innerHTML = `<div class="dtf-wrap">
    <div class="card">
      <div class="card-h"><h3>Trim & resize to print size</h3><div class="spacer"></div>
        <span class="dim" style="font-size:11.5px">runs in your browser — art never uploads</span></div>
      <div class="card-b">
        <label class="csv-drop" id="dtf-drop"><input type="file" id="dtf-file" accept="image/png" hidden>
          <div id="dtf-drop-txt">Choose a transparent PNG — we trim the empty space automatically</div></label>
        <div class="dtf-controls" id="dtf-controls" hidden>
          <div class="grid4">
            <div class="field"><label>Width (in)</label><input class="input" id="dtf-w" type="number" step="0.05" min="0.2"></div>
            <div class="field"><label>Height (in)</label><input class="input" id="dtf-h" type="number" step="0.05" min="0.2"></div>
            <div class="field"><label>DPI</label><input class="input" id="dtf-dpi" type="number" value="300" min="72" max="1200"></div>
            <div class="field"><label>Alpha threshold</label><input class="input" id="dtf-alpha" type="number" value="1" min="0" max="254"></div>
          </div>
          <label class="row" style="gap:7px;cursor:pointer;margin:4px 0 10px"><input type="checkbox" id="dtf-lock" checked><span style="font-size:12.5px">Lock aspect ratio</span></label>
          <div class="row" style="gap:8px">
            <button class="btn" id="dtf-apply">Resize</button>
            <a class="btn ghost" id="dtf-dl" hidden download>Download print-ready PNG</a>
            <button class="btn ghost sm" id="dtf-reset">Start over</button>
          </div>
          <div class="dim" id="dtf-stats" style="font-size:12px;margin-top:10px;line-height:1.6"></div>
        </div>
      </div>
    </div>
    <div class="cols" style="margin-top:16px">
      <div class="card"><div class="card-h"><h3>Original (trim shown)</h3></div><div class="card-b dtf-stage"><canvas id="dtf-before"></canvas></div></div>
      <div class="card"><div class="card-h"><h3>Print-ready output</h3></div><div class="card-b dtf-stage"><canvas id="dtf-after"></canvas></div></div>
    </div>
    <p class="dim" style="font-size:11.5px;text-align:center;margin-top:12px">The output PNG carries true DPI metadata (pHYs), so your RIP and gang-sheet software place it at exact physical size.</p>

    <div class="card" style="margin-top:16px">
      <div class="card-h"><h3>Print quality &amp; upscale</h3><div class="spacer"></div>
        <span class="dim" id="dtf-q-pill" style="font-size:11.5px">load art to check</span></div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:12px">Before you print it, find out whether the art is actually sharp enough at the size you need. Upscaling improves smoothness, but it cannot invent detail that was never in the file — if this says the art is too low, ask the customer for the original.</p>
        <div class="grid4">
          <div class="field"><label>Upscale</label>
            <select class="input" id="dtf-up-f"><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></div>
          <div class="field" style="grid-column:span 3;align-self:end">
            <div class="row" style="gap:8px">
              <button class="btn ghost" id="dtf-up-go">Upscale art</button>
              <a class="btn ghost" id="dtf-up-dl" hidden download>Download upscaled PNG</a>
            </div></div>
        </div>
        <div id="dtf-quality" class="dtf-q"></div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-h"><h3>Gang sheet planner</h3><div class="spacer"></div>
        <span class="dim" style="font-size:11.5px">${rollW}&quot; roll · ${money(perInch)}/inch</span></div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:12px">How many of this design fit across the roll, how far down the roll the run pushes you, which standard sheet it needs, and what that costs.</p>
        <div class="grid4">
          <div class="field"><label>Piece width (in)</label><input class="input" id="gs-w" type="number" step="0.25" value="10"></div>
          <div class="field"><label>Piece height (in)</label><input class="input" id="gs-h" type="number" step="0.25" value="12"></div>
          <div class="field"><label>Quantity</label><input class="input" id="gs-q" type="number" step="1" min="1" value="48"></div>
          <div class="field"><label>Gap (in)</label><input class="input" id="gs-g" type="number" step="0.05" min="0" value="0.25"></div>
        </div>
        <div class="row" style="gap:8px;margin-top:4px">
          <button class="btn ghost sm" id="gs-fromart" hidden>Use the size above</button>
        </div>
        <div id="gs-out" class="dtf-q" style="margin-top:12px"></div>
      </div>
    </div>
  </div>`

  const drop = $('#dtf-drop'), fileIn = $('#dtf-file')
  drop.onclick = () => fileIn.click()
  drop.ondragover = (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)' }
  drop.ondragleave = () => { drop.style.borderColor = '' }
  drop.ondrop = (e) => { e.preventDefault(); drop.style.borderColor = ''; if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]) }
  fileIn.onchange = () => { if (fileIn.files[0]) load(fileIn.files[0]) }
  $('#dtf-apply').onclick = apply
  $('#dtf-reset').onclick = () => dtfResizeView()
  $('#dtf-lock').onchange = () => syncSize('width')
  $('#dtf-w').oninput = () => { syncSize('width'); quality() }
  $('#dtf-h').oninput = () => { syncSize('height'); quality() }
  $('#dtf-alpha').onchange = async () => { if (st.img) { st.crop = analyzeTrim(st.img, +$('#dtf-alpha').value); drawPreview('dtf-before', st.img, st.crop); stats(); quality() } }

  /* ---- print quality + upscale ---- */

  /** Re-read the verdict whenever the art or the target size changes. */
  function quality() {
    const box = $('#dtf-quality'), pill = $('#dtf-q-pill')
    if (!st.crop) { box.innerHTML = ''; pill.textContent = 'load art to check'; return }
    const wIn = +$('#dtf-w').value, hIn = +$('#dtf-h').value
    const q = printQuality(st.crop.w, st.crop.h, wIn, hIn)
    if (!q) { box.innerHTML = ''; return }
    const max = maxPrintSize(st.crop.w, st.crop.h, 300)
    const TONE = { good: 'green', ok: 'green', warn: 'amber', bad: 'red' }
    pill.innerHTML = `<span class="pill ${TONE[q.level]}">${q.dpi} DPI</span>`
    box.innerHTML = `<div class="dtf-q-row ${q.level}">
        <strong>${q.dpi} DPI at ${wIn}&quot; × ${hIn}&quot;</strong>
        <span>${esc(q.label)}</span>
      </div>
      <div class="dim" style="font-size:11.5px;margin-top:8px;line-height:1.6">
        This art holds full 300 DPI quality up to <strong>${max.widthIn}&quot; × ${max.heightIn}&quot;</strong>.
        ${q.level === 'bad' ? ' Upscaling will smooth the edges but will not bring back detail — the honest fix is a better source file.' : ''}
      </div>`
  }

  $('#dtf-up-go').onclick = async () => {
    if (!st.img || !st.crop) return toast('Load a PNG first', true)
    const btn = $('#dtf-up-go'); btn.disabled = true; btn.textContent = 'Upscaling…'
    try {
      const { canvas, outW, outH, factor } = upscale(st.img, st.crop, +$('#dtf-up-f').value)
      const blob = await canvasToPngBlob(canvas)
      if (st.upUrl) URL.revokeObjectURL(st.upUrl)
      st.upUrl = URL.createObjectURL(blob)
      const dl = $('#dtf-up-dl'); dl.hidden = false; dl.href = st.upUrl
      dl.download = `${(st.file?.name || 'art').replace(/\.png$/i, '')}-${factor}x.png`
      drawPreview('dtf-after', canvas)
      toast(`Upscaled to ${outW}×${outH}px`)
    } catch (e) { toast(e.message, true) }
    btn.disabled = false; btn.textContent = 'Upscale art'
  }

  /* ---- gang sheet planner ---- */

  function plan() {
    const out = $('#gs-out')
    const layout = gangSheetLayout({
      pieceW: +$('#gs-w').value, pieceH: +$('#gs-h').value,
      qty: +$('#gs-q').value, sheetWidth: rollW, gap: +$('#gs-g').value,
    })
    if (!layout) { out.innerHTML = '<span class="dim">Enter a size and quantity.</span>'; return }
    if (layout.error) { out.innerHTML = `<div class="dtf-q-row bad"><strong>Won't fit</strong><span>${esc(layout.error)}</span></div>`; return }
    const price = gangSheetPrice(layout.lengthIn, perInch, minChg)
    const sheet = fitSheet(layout.lengthIn)
    out.innerHTML = `<div class="dtf-q-row ${layout.efficiency >= 75 ? 'good' : 'warn'}">
        <strong>${layout.perRow} across · ${layout.rows} rows · ${layout.lengthIn}&quot; of roll (${layout.lengthFt} ft)</strong>
        <span>${layout.efficiency}% of the sheet is printed${layout.slotsUnused ? ` · ${layout.slotsUnused} empty slot${layout.slotsUnused === 1 ? '' : 's'} you could fill with another design` : ''}</span>
      </div>
      <div class="gs-facts">
        <div><span class="dim">Standard sheet</span><strong>${sheet ? esc(sheet.label) : `custom — over ${SHEET_SIZES[SHEET_SIZES.length - 1].h}&quot;`}</strong></div>
        <div><span class="dim">Roll used</span><strong>${layout.lengthIn}&quot;</strong></div>
        <div><span class="dim">Sheet cost</span><strong>${money(price)}</strong></div>
        <div><span class="dim">Per piece</span><strong>${money(price / Math.max(1, +$('#gs-q').value))}</strong></div>
      </div>`
  }

  ;['#gs-w', '#gs-h', '#gs-q', '#gs-g'].forEach((sel) => { $(sel).oninput = plan })
  $('#gs-fromart').onclick = () => {
    $('#gs-w').value = $('#dtf-w').value
    $('#gs-h').value = $('#dtf-h').value
    plan()
  }
  plan()

  async function load(file) {
    try {
      if (!/\.png$/i.test(file.name) && file.type !== 'image/png') return toast('Use a transparent PNG', true)
      reset()
      st.file = file
      st.url = URL.createObjectURL(file)
      st.srcDpi = readPngDpi(await file.arrayBuffer())
      const img = await loadImage(st.url)
      st.img = img
      st.crop = analyzeTrim(img, +($('#dtf-alpha')?.value || 1))
      if (!st.crop) return toast('No visible pixels found — is the PNG fully transparent?', true)
      $('#dtf-drop-txt').textContent = `${file.name}`
      $('#dtf-controls').hidden = false
      // Default size: the trimmed art at its native DPI (or 300), capped to a sane print width.
      const dpi = Math.round(st.srcDpi?.x || 300)
      $('#dtf-dpi').value = dpi
      const wIn = Math.min(12, +(st.crop.w / dpi).toFixed(2)) || 10
      $('#dtf-w').value = wIn
      $('#dtf-h').value = +(wIn * st.crop.h / st.crop.w).toFixed(2)
      drawPreview('dtf-before', img, st.crop)
      stats()
      quality()
      $('#gs-fromart').hidden = false
    } catch (e) { toast(e.message, true) }
  }

  function syncSize(changed) {
    if (!$('#dtf-lock').checked || !st.crop) return
    const ratio = st.crop.h / st.crop.w
    if (changed === 'width' && +$('#dtf-w').value > 0) $('#dtf-h').value = +(+$('#dtf-w').value * ratio).toFixed(2)
    if (changed === 'height' && +$('#dtf-h').value > 0) $('#dtf-w').value = +(+$('#dtf-h').value / ratio).toFixed(2)
  }

  async function apply() {
    try {
      const { canvas, outW, outH, dpi } = resizeToPrint(st.img, st.crop, { widthIn: +$('#dtf-w').value, heightIn: +$('#dtf-h').value, dpi: +$('#dtf-dpi').value })
      const blob = await addPngDpi(await canvasToPngBlob(canvas), dpi)
      if (st.outUrl) URL.revokeObjectURL(st.outUrl)
      st.outUrl = URL.createObjectURL(blob)
      st.outName = `${(st.file?.name || 'art').replace(/\.png$/i, '')}-${$('#dtf-w').value}in-${dpi}dpi.png`
      const dl = $('#dtf-dl'); dl.hidden = false; dl.href = st.outUrl; dl.download = st.outName
      drawPreview('dtf-after', canvas)
      stats({ outW, outH, dpi })
      toast('Print-ready PNG built')
    } catch (e) { toast(e.message, true) }
  }

  function stats(out) {
    const parts = []
    if (st.crop) parts.push(`Trimmed ${st.crop.sourceW}×${st.crop.sourceH} → <strong>${st.crop.w}×${st.crop.h}px</strong> (${Math.round(100 - (st.crop.w * st.crop.h) / (st.crop.sourceW * st.crop.sourceH) * 100)}% empty space removed)`)
    if (st.srcDpi) parts.push(`Source DPI: ${Math.round(st.srcDpi.x)}`)
    if (out) parts.push(`Output: <strong>${$('#dtf-w').value}″ × ${$('#dtf-h').value}″ at ${out.dpi} DPI</strong> (${out.outW}×${out.outH}px, DPI embedded)`)
    $('#dtf-stats').innerHTML = parts.join(' · ')
  }

  function drawPreview(id, source, crop) {
    const cv = $(`#${id}`); if (!cv) return
    const maxW = 420, maxH = 300
    const sw = crop ? crop.sourceW ?? source.width : source.width
    const sh = crop ? crop.sourceH ?? source.height : source.height
    const scale = Math.min(maxW / sw, maxH / sh, 1)
    cv.width = Math.max(1, Math.round(sw * scale)); cv.height = Math.max(1, Math.round(sh * scale))
    const ctx = cv.getContext('2d')
    // checkerboard so transparency reads
    for (let y = 0; y < cv.height; y += 8) for (let x = 0; x < cv.width; x += 8) { ctx.fillStyle = ((x + y) / 8) % 2 ? '#2a2f3a' : '#232833'; ctx.fillRect(x, y, 8, 8) }
    ctx.drawImage(source, 0, 0, cv.width, cv.height)
    if (crop && crop.sourceW) {
      ctx.strokeStyle = '#10d39a'; ctx.lineWidth = 2; ctx.setLineDash([6, 4])
      ctx.strokeRect(crop.x * scale, crop.y * scale, crop.w * scale, crop.h * scale)
    }
  }
}
