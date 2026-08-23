import { api, $, $$, esc, money, setPage, toast, on } from '../core.js'
import { nest, priceSheet, round2 } from '../shared/gangnest.js'
import { addPngDpi, canvasToPngBlob, loadImage, SHEET_SIZES } from '../shared/dtftrim.js'

/**
 * Gang Sheet Builder — the shop's own version of the builder its customers get on the website.
 *
 * Drop in as many designs as you like, set the printed size and quantity of each, and they nest onto
 * the roll live. The same nest() engine drives the customer embed, so what a shop sees here and what
 * it quotes a customer can never disagree. The export is a real print-ready PNG at 300 DPI with pHYs
 * metadata, so it drops straight into a RIP at exact physical size.
 *
 * Everything happens in the browser — the art never leaves the machine.
 */

const PPI = 20            // preview pixels per inch
const EXPORT_DPI = 300
/**
 * Browsers cap a canvas dimension at 16384px — a 22"×120" sheet at 300 DPI is 36,000px tall and
 * would come back silently blank rather than throwing. So the exporter drops DPI to whatever fits,
 * never below 150 (the floor for a usable transfer), and says which DPI it actually used.
 */
const MAX_CANVAS_PX = 16384
const MIN_EXPORT_DPI = 150
const dpiForLength = (inches) => Math.min(EXPORT_DPI, Math.floor(MAX_CANVAS_PX / Math.max(1, inches)))

let designs = []          // { id, name, img, wIn, hIn, qty }
let cfg = { sheetWidth: 22, pricePerInch: 0.95, minCharge: 10 }
let seq = 0

export async function gangSheetView() {
  designs = []; seq = 0
  setPage('Gang Sheet Builder', '<button class="btn ghost" id="gs-clear">Clear sheet</button>')
  const s = (await api.get('/api/settings').catch(() => ({ settings: {} }))).settings || {}
  cfg = {
    sheetWidth: Number(s.dtf_sheet_width) || 22,
    pricePerInch: Number(s.dtf_price_per_inch) || 0.95,
    minCharge: Number(s.dtf_min_charge) || 10,
  }

  $('#view').innerHTML = `<div class="gsb">
    <div class="gsb-side">
      <div class="card">
        <div class="card-h"><h3>Designs</h3><div class="spacer"></div>
          <span class="dim" style="font-size:11px">${cfg.sheetWidth}&quot; roll</span></div>
        <div class="card-b">
          <label class="csv-drop" id="gsb-drop">
            <input type="file" id="gsb-file" accept="image/png,image/webp" multiple hidden>
            <div id="gsb-drop-txt">Add PNGs — drop them here or click</div>
          </label>
          <div id="gsb-list" class="gsb-list"></div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-h"><h3>Sheet</h3></div>
        <div class="card-b">
          <div class="field"><label>Sheet length</label>
            <select class="input" id="gsb-size">
              <option value="auto">Auto — only what's used</option>
              ${SHEET_SIZES.map((z) => `<option value="${z.h}">${esc(z.label)}</option>`).join('')}
            </select></div>
          <div class="field" style="margin-top:10px"><label>Gap between pieces (in)</label>
            <input class="input" id="gsb-gap" type="number" step="0.05" min="0" value="0.25"></div>
          <div id="gsb-facts" class="gs-facts" style="grid-template-columns:1fr 1fr"></div>
          <div id="gsb-warn" class="dtf-q-row warn" style="margin-top:10px;font-size:12.5px" hidden></div>
          <div class="row" style="gap:8px;margin-top:12px">
            <button class="btn" id="gsb-export">Export print-ready PNG</button>
            <a class="btn ghost" id="gsb-dl" hidden download>Download</a>
          </div>
          <div class="dim" style="font-size:11px;margin-top:8px;line-height:1.6">Exports at ${EXPORT_DPI} DPI with real size metadata (very long sheets drop DPI to fit, and say so). Art never leaves your browser.</div>
        </div>
      </div>
    </div>

    <div class="card gsb-stage-card">
      <div class="card-h"><h3 id="gsb-lbl">Sheet preview</h3><div class="spacer"></div>
        <span id="gsb-price" class="dim" style="font-size:12.5px"></span></div>
      <div class="card-b gsb-stage"><canvas id="gsb-canvas"></canvas>
        <div id="gsb-empty" class="dim" style="text-align:center;padding:40px 12px;font-size:13px">Add a design to start building the sheet.</div>
      </div>
    </div>
  </div>`

  const drop = $('#gsb-drop'), fileIn = $('#gsb-file')
  drop.onclick = () => fileIn.click()
  drop.ondragover = (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)' }
  drop.ondragleave = () => { drop.style.borderColor = '' }
  drop.ondrop = (e) => { e.preventDefault(); drop.style.borderColor = ''; addFiles(e.dataTransfer.files) }
  fileIn.onchange = () => { const picked = [...fileIn.files]; fileIn.value = ''; addFiles(picked) }
  $('#gsb-size').onchange = draw
  $('#gsb-gap').oninput = draw
  $('#gs-clear').onclick = () => { designs = []; renderList(); draw() }
  $('#gsb-export').onclick = exportSheet

  // One delegated binding for every row control, so adding designs never stacks handlers.
  on($('#gsb-list'), '[data-del]', (_e, t) => { designs = designs.filter((d) => d.id !== +t.dataset.del); renderList(); draw() })
  on($('#gsb-list'), '[data-dup]', (_e, t) => {
    const d = designs.find((x) => x.id === +t.dataset.dup)
    if (d) { designs.push({ ...d, id: ++seq }); renderList(); draw() }
  })
  $('#gsb-list').addEventListener('input', (e) => {
    const t = e.target
    const d = designs.find((x) => x.id === +t.dataset.id)
    if (!d) return
    if (t.dataset.f === 'w') { d.wIn = Math.max(0.25, Number(t.value) || 0); d.hIn = round2(d.wIn * (d.img.height / d.img.width)) }
    if (t.dataset.f === 'qty') d.qty = Math.max(1, Math.floor(Number(t.value) || 1))
    renderFacts(); draw()
  })

  renderList(); draw()
}

async function addFiles(files) {
  const list = [...(files || [])].slice(0, 40)
  for (const f of list) {
    // Judge by extension OR MIME: a file dragged from some apps (and some upload paths) arrives with
    // an empty `type`, and rejecting on that alone silently drops perfectly good art.
    const looksRight = /\.(png|webp)$/i.test(f.name || '') || /^image\/(png|webp)$/.test(f.type || '')
    if (!looksRight) { toast(`${f.name} isn't a PNG`, true); continue }
    try {
      const img = await loadImage(URL.createObjectURL(f))
      // Default to a sensible print width that still fits the roll.
      const wIn = Math.min(cfg.sheetWidth, 10)
      designs.push({ id: ++seq, name: f.name, img, wIn, hIn: round2(wIn * (img.height / img.width)), qty: 1 })
    } catch { toast(`Could not read ${f.name}`, true) }
  }
  renderList(); draw()
}

function renderList() {
  $('#gsb-drop-txt').textContent = designs.length ? `Add more — ${designs.length} design${designs.length === 1 ? '' : 's'} on the sheet` : 'Add PNGs — drop them here or click'
  $('#gsb-list').innerHTML = designs.map((d) => `<div class="gsb-item">
    <img src="${d.img.src}" alt="">
    <div class="gsb-item-b">
      <div class="gsb-item-n" title="${esc(d.name)}">${esc(d.name)}</div>
      <div class="gsb-item-f">
        <label>W&quot;<input class="input" type="number" step="0.25" min="0.25" value="${d.wIn}" data-id="${d.id}" data-f="w"></label>
        <label>Copies<input class="input" type="number" step="1" min="1" value="${d.qty}" data-id="${d.id}" data-f="qty" style="width:64px"></label>
        <span class="dim">${d.hIn}&quot; tall</span>
      </div>
    </div>
    <div class="gsb-item-a">
      <button class="btn ghost sm" data-dup="${d.id}" title="Add a separate copy of this design as its own row">＋</button>
      <button class="btn ghost sm" data-del="${d.id}" title="Remove" style="color:var(--red)">×</button>
    </div>
  </div>`).join('')
}

/** Nest with the current settings. Shared with the customer embed, so quotes always agree. */
function computed() {
  const gap = Math.max(0, Number($('#gsb-gap')?.value) || 0)
  const items = designs.map((d, i) => ({ w: d.wIn, h: d.hIn, qty: d.qty, i }))
  const n = nest(items, { sheetWidth: cfg.sheetWidth, gap })
  // A fixed sheet length still bills for the whole sheet even if the art doesn't fill it — but it
  // must never bill for LESS than the art actually needs. Picking a 60" sheet for 149" of nested art
  // used to quote the 60" price and then export a cropped sheet with half the pieces missing.
  const pick = $('#gsb-size')?.value
  const chosen = pick && pick !== 'auto' ? Number(pick) : 0
  const overflows = chosen > 0 && n.usedHeight > chosen + 1e-6
  const billed = Math.max(chosen, n.usedHeight)
  return { n, gap, billed, chosen, overflows, price: priceSheet(billed, cfg) }
}

function renderFacts() {
  const { n, billed, chosen, overflows, price } = computed()
  const area = designs.reduce((a, d) => a + d.wIn * d.hIn * d.qty, 0)
  // Efficiency is against the length actually consumed, so it can never read over 100%.
  const eff = billed > 0 ? Math.min(100, Math.round((area / (cfg.sheetWidth * billed)) * 100)) : 0
  $('#gsb-facts').innerHTML = `
    <div><span class="dim">Pieces</span><strong>${n.count}</strong></div>
    <div><span class="dim">Roll used</span><strong>${Math.ceil(billed)}&quot;</strong></div>
    <div><span class="dim">Sheet used</span><strong>${eff}%</strong></div>
    <div><span class="dim">Cost</span><strong>${money(price.subtotal)}</strong></div>`
  const warn = $('#gsb-warn')
  if (warn) {
    warn.hidden = !overflows
    if (overflows) warn.innerHTML = `This won't fit a ${chosen}&quot; sheet — the art needs <strong>${Math.ceil(billed)}&quot;</strong>. Pick a longer sheet or cut the quantity; nothing will be cropped, and the price shown is for the ${Math.ceil(billed)}&quot; it really takes.`
  }
}

function draw() {
  const { n, billed, price } = computed()
  const c = $('#gsb-canvas'), empty = $('#gsb-empty')
  if (!c) return
  empty.hidden = n.count > 0
  c.hidden = n.count === 0
  renderFacts()
  $('#gsb-lbl').textContent = n.count ? `${n.count} piece${n.count === 1 ? '' : 's'} · ${Math.ceil(billed)}" of roll` : 'Sheet preview'
  $('#gsb-price').textContent = n.count ? `${money(price.subtotal)} · ${cfg.sheetWidth}" roll` : ''
  if (!n.count) return

  const W = Math.round(cfg.sheetWidth * PPI)
  const H = Math.round(Math.max(4, billed) * PPI)
  c.width = W; c.height = H
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#f2f5f9'; ctx.fillRect(0, 0, W, H)
  // Roll edges + a foot ruler, so the length reads at a glance.
  ctx.strokeStyle = '#c8d0da'; ctx.setLineDash([4, 4]); ctx.strokeRect(0.5, 0.5, W - 1, H - 1); ctx.setLineDash([])
  ctx.fillStyle = '#98a2b3'; ctx.font = '9px sans-serif'
  for (let ft = 1; ft * 12 < billed; ft++) {
    const y = ft * 12 * PPI
    ctx.strokeStyle = '#dde3ec'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
    ctx.fillText(`${ft} ft`, 3, y - 3)
  }
  for (const p of n.placements) {
    const d = designs[p.i]
    if (d) ctx.drawImage(d.img, p.x * PPI, p.y * PPI, p.w * PPI, p.h * PPI)
  }
}

/** Render the nested sheet at full print resolution and stamp it with real DPI. */
async function exportSheet() {
  const { n, billed } = computed()
  if (!n.count) return toast('Add a design first', true)
  const btn = $('#gsb-export'); btn.disabled = true; btn.textContent = 'Building…'
  try {
    const dpi = dpiForLength(billed)
    if (dpi < MIN_EXPORT_DPI) {
      const maxIn = Math.floor(MAX_CANVAS_PX / MIN_EXPORT_DPI)
      throw new Error(`A ${Math.ceil(billed)}" sheet is too long to export in one file — build it as two sheets of ${maxIn}" or less`)
    }
    const W = Math.round(cfg.sheetWidth * dpi)
    const H = Math.round(billed * dpi)
    const c = document.createElement('canvas'); c.width = W; c.height = H
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, W, H) // transparent background — it's a transfer, not a poster
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
    for (const p of n.placements) {
      const d = designs[p.i]
      if (d) ctx.drawImage(d.img, p.x * dpi, p.y * dpi, p.w * dpi, p.h * dpi)
    }
    // Verify the canvas actually allocated — an over-large one comes back zero-sized, not thrown.
    if (c.width !== W || c.height !== H) throw new Error('The browser could not build a sheet that large — split it into two sheets')
    const blob = await addPngDpi(await canvasToPngBlob(c), dpi)
    const dl = $('#gsb-dl')
    if (dl.href.startsWith('blob:')) URL.revokeObjectURL(dl.href)
    dl.href = URL.createObjectURL(blob)
    dl.download = `gangsheet-${cfg.sheetWidth}x${Math.ceil(billed)}in-${dpi}dpi.png`
    dl.hidden = false
    toast(dpi < EXPORT_DPI
      ? `Sheet built — ${cfg.sheetWidth}" × ${Math.ceil(billed)}" at ${dpi} DPI (lowered to fit this length)`
      : `Sheet built — ${cfg.sheetWidth}" × ${Math.ceil(billed)}" at ${dpi} DPI`)
  } catch (e) { toast(e.message, true) }
  btn.disabled = false; btn.textContent = 'Export print-ready PNG'
}
