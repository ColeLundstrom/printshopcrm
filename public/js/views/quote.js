import { $, $$, esc, money, modal, closeModal, toast, on } from '../core.js'
import { quoteScreenPrint, priceBreaks, jobCost, margin, marginVerdict, markupVsMargin, valuePerHour, RUSH_TIERS, round2 } from '../shared/pricing.js'
import { servicePerPiece, SERVICE_METHODS } from '../shared/servicecost.js'

const DECORATIONS = ['Screen Print', ...SERVICE_METHODS]

/**
 * The quoting calculator — and the reason this product exists.
 *
 * Shops don't discover they underpriced from a report; they discover it months later
 * watching gross revenue. So the margin is computed live, against real press times and
 * the shop's true utilization, while the price is still editable. If the job loses money
 * it says so here, before it's sent.
 */
export function quoteModal(settings, onUse) {
  const state = {
    decoration: 'Screen Print',
    garmentCost: 3.20,
    markup: Number(settings.default_markup) || 2.0,
    qty: 100,
    screenFee: Number(settings.screen_fee) || 25,
    rushMult: 1,
    darkGarment: false,
    press: settings.press_type || 'auto',
    locations: [{ name: 'Front', colors: 2 }],
    // non-screen decoration inputs
    widthIn: 10, heightIn: 12, patchSizeIn: 3, liveEmbroidery: false,
  }
  const isService = () => SERVICE_METHODS.includes(state.decoration)

  const shopRate = Number(settings.shop_hourly_rate) || 75
  const utilization = (Number(settings.utilization_pct) || 30) / 100
  const spoilage = Number(settings.spoilage_pct) || 2
  const LOCS = ['Front', 'Back', 'Left Chest', 'Right Chest', 'Sleeve', 'Hood', 'Yoke']

  modal({
    title: 'Price Calculator',
    wide: true,
    body: `<div class="quote">
      <div class="quote-in">
        <div class="field"><label>Decoration</label><select class="input" id="q-deco">
          ${DECORATIONS.map((d) => `<option ${d === state.decoration ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
        <div class="grid2">
          <div class="field"><label>Garment cost (what you pay)</label>
            <input class="input" id="q-cost" type="number" step="0.01" min="0" value="${state.garmentCost}"></div>
          <div class="field"><label>Markup ×</label>
            <input class="input" id="q-markup" type="number" step="0.05" min="1" value="${state.markup}"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Quantity</label>
            <input class="input" id="q-qty" type="number" min="1" value="${state.qty}"></div>
          <div class="field" id="q-screen-f"><label>Screen fee (each)</label>
            <input class="input" id="q-screen" type="number" step="1" min="0" value="${state.screenFee}"></div>
        </div>

        <div id="q-sp">
          <div class="field"><label>Print locations</label><div id="q-locs"></div>
            <button class="btn ghost sm" id="q-addloc" style="margin-top:7px">+ Add location</button>
          </div>
          <div class="grid2">
            <div class="field"><label>Press</label><select class="input" id="q-press">
              <option value="auto" ${state.press === 'auto' ? 'selected' : ''}>Automatic</option>
              <option value="manual" ${state.press === 'manual' ? 'selected' : ''}>Manual</option>
            </select></div>
            <label class="row" style="gap:7px;cursor:pointer;align-items:center;margin-top:22px">
              <input type="checkbox" id="q-dark"> <span style="font-size:13px">Dark garment (underbase)</span></label>
          </div>
        </div>

        <div id="q-svc" hidden>
          <div class="grid2" id="q-svc-size">
            <div class="field"><label>Print width (in)</label><input class="input" id="q-w" type="number" step="0.25" min="0.5" value="${state.widthIn}"></div>
            <div class="field"><label>Print height (in)</label><input class="input" id="q-h" type="number" step="0.25" min="0.5" value="${state.heightIn}"></div>
          </div>
          <div class="field" id="q-svc-patch" hidden><label>Patch size (in)</label>
            <select class="input" id="q-patch">${['2', '2.5', '3', '3.5', '4', '4.5', '5', '5.5'].map((n) => `<option ${+n === state.patchSizeIn ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          <label class="row" id="q-svc-emb" hidden style="gap:7px;cursor:pointer"><input type="checkbox" id="q-live"> <span style="font-size:13px">Live-digitized embroidery (higher stitch count)</span></label>
        </div>

        <div class="field"><label>Turnaround</label><select class="input" id="q-rush">
          ${RUSH_TIERS.map((t) => `<option value="${t.mult}">${t.label}${t.mult > 1 ? ` (+${Math.round((t.mult - 1) * 100)}%)` : ''}</option>`).join('')}
        </select></div>
      </div>

      <div class="quote-out">
        <div class="qhead">
          <div class="qbig"><span id="q-pp">$0.00</span><em>recommended price / piece</em></div>
          <div class="qhead-total" id="q-total"></div>
        </div>
        <div id="q-verdict"></div>
        <div class="qtiles">
          <div class="qtile"><div class="qtile-l">Gross profit</div><div class="qtile-v" id="q-profit">$0</div></div>
          <div class="qtile"><div class="qtile-l">Gross margin</div><div class="qtile-v" id="q-marginv">0%</div></div>
          <div class="qtile" id="q-conf-tile"><div class="qtile-l">Cost basis</div><div class="qtile-v" id="q-conf">Est.</div></div>
        </div>
        <button class="qshow" id="q-showcalc" type="button">Show the calculation ▾</button>
        <div id="q-calc" hidden>
          <div class="qbreak" id="q-break"></div>
          <div class="qtable"><h4>Price at other quantities</h4><div id="q-breaks"></div></div>
        </div>
      </div>
    </div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="q-use">Add to estimate</button>`,
    onMount: (bg) => {
      const drawLocs = () => {
        $('#q-locs', bg).innerHTML = state.locations.map((l, i) => `<div class="qloc" data-i="${i}">
          <select class="input" data-lf="name">${LOCS.map((n) => `<option ${n === l.name ? 'selected' : ''}>${n}</option>`).join('')}</select>
          <input class="input num" data-lf="colors" type="number" min="1" max="12" value="${l.colors}">
          <span class="dim" style="font-size:11px">colors${state.darkGarment ? ' +UB' : ''}</span>
          ${state.locations.length > 1 ? `<button class="del" data-rmloc="${i}">&times;</button>` : '<span></span>'}
        </div>`).join('')
      }

      // Real cost-based quote for a non-screen decoration (DTF, UV DTF, embroidery, patch, laser).
      const serviceQuote = (qty) => {
        const svc = servicePerPiece(state.decoration, qty, { widthIn: state.widthIn, heightIn: state.heightIn, patchSizeIn: state.patchSizeIn, liveEmbroidery: state.liveEmbroidery })
        const garment = round2(state.garmentCost * state.markup)
        const perPiece = round2((garment + svc.sell) * state.rushMult)
        const fee = svc.fee || 0
        const subtotal = round2(perPiece * qty + fee)
        const decoCost = svc.cost != null ? svc.cost : round2(svc.sell * 0.5)
        const garmentC = round2(state.garmentCost * (1 + spoilage / 100))
        const costTotal = round2((garmentC + decoCost) * qty)
        const m = margin(round2(perPiece * qty), costTotal)
        return { svc, garment, perPiece, fee, subtotal, m }
      }

      const renderService = () => {
        const q = serviceQuote(state.qty)
        const v = marginVerdict(q.m.margin)
        $('#q-pp', bg).textContent = money(q.perPiece)
        $('#q-total', bg).textContent = `${money(q.subtotal)} order total · ${state.qty} pcs${q.fee ? ` (incl. ${money(q.fee)} ${q.svc.feeLabel || 'setup'})` : ''}`
        $('#q-profit', bg).textContent = money(q.m.profit)
        const me = $('#q-marginv', bg); me.textContent = `${q.m.margin}%`
        me.style.color = v.level === 'good' ? 'var(--accent)' : v.level === 'warn' ? 'var(--amber)' : 'var(--red)'
        $('#q-conf', bg).textContent = q.svc.cost != null ? 'Cost model' : 'Estimated'
        $('#q-conf-tile', bg).title = `${state.decoration} priced from real cost data — ${q.svc.basis}.`
        $('#q-verdict', bg).innerHTML = `<div class="qverdict ${v.level}"><span class="qv-label">${v.label}</span>
          <span class="qv-vph">${esc(state.decoration)} · ${esc(q.svc.basis)}</span>
          ${q.m.margin < 25 ? `<div class="qv-warn">${q.m.margin < 0 ? 'This job loses money. Raise the price.' : 'Under 25% is thin. Raise the price or the quantity.'}</div>` : ''}</div>`
        $('#q-break', bg).innerHTML = `
          <div><span>Garment (${money(state.garmentCost)} × ${state.markup})</span><span>${money(q.garment)}</span></div>
          <div><span>${esc(state.decoration)} — ${esc(q.svc.basis)}</span><span>${money(q.svc.sell)}</span></div>
          ${state.rushMult > 1 ? `<div style="color:var(--amber)"><span>Rush +${Math.round((state.rushMult - 1) * 100)}%</span><span>included</span></div>` : ''}
          <div class="qline"><span>Per piece</span><span>${money(q.perPiece)}</span></div>
          <div><span>${state.qty} pieces</span><span>${money(q.perPiece * state.qty)}</span></div>
          ${q.fee ? `<div><span>${esc(q.svc.feeLabel || 'Setup')}</span><span>${money(q.fee)}</span></div>` : ''}
          <div class="qline strong"><span>Order total</span><span>${money(q.subtotal)}</span></div>`
        // qty price breaks (methods with real qty tiers move; area-priced ones are flat)
        $('#q-breaks', bg).innerHTML = [24, 48, 72, 144, 288, 500].map((qq) => {
          const b = serviceQuote(qq)
          return `<div class="qb ${qq === state.qty ? 'on' : ''}" data-qty="${qq}"><span>${qq}</span><strong>${money(b.perPiece)}</strong>
            <em class="${marginVerdict(b.m.margin).level}">${b.m.margin}%</em></div>`
        }).join('')
      }

      const render = () => {
        // Toggle which inputs are relevant to the chosen decoration.
        const svc = isService()
        $('#q-sp', bg).hidden = svc
        $('#q-svc', bg).hidden = !svc
        $('#q-screen-f', bg).style.visibility = svc ? 'hidden' : 'visible'
        if (svc) {
          const sizeMethods = state.decoration === 'DTF Transfer' || state.decoration === 'UV DTF'
          $('#q-svc-size', bg).hidden = !sizeMethods
          $('#q-svc-patch', bg).hidden = state.decoration !== 'Patch'
          $('#q-svc-emb', bg).hidden = state.decoration !== 'Embroidery'
          return renderService()
        }
        const q = quoteScreenPrint(state)
        const colorsPerLoc = Math.max(...state.locations.map((l) => (Number(l.colors) || 1) + (state.darkGarment ? 1 : 0)), 1)
        const cost = jobCost({ qty: state.qty, colors: colorsPerLoc, garmentCost: state.garmentCost,
          press: state.press, shopRate, utilization, spoilage, screens: q.totalColors, screenCost: 8 })
        const m = margin(q.subtotal, cost.total)
        const v = marginVerdict(m.margin)
        const mm = markupVsMargin(cost.perPiece, q.perPiece)
        const vph = valuePerHour(q.subtotal, cost.minutes)

        // One clear answer up top: recommended price, what you keep, the margin, and how solid the
        // cost is. The full math lives behind "Show the calculation".
        $('#q-pp', bg).textContent = money(q.perPiece)
        $('#q-total', bg).textContent = `${money(q.subtotal)} order total · ${state.qty} pcs`
        $('#q-profit', bg).textContent = money(m.profit)
        const marginEl = $('#q-marginv', bg)
        marginEl.textContent = `${m.margin}%`
        marginEl.style.color = v.level === 'good' ? 'var(--accent)' : v.level === 'warn' ? 'var(--amber)' : 'var(--red)'
        // Confidence: the garment cost here is typed, so it's an estimate until a distributor is connected.
        $('#q-conf', bg).textContent = 'Estimated'
        $('#q-conf-tile', bg).title = 'Based on the garment cost you typed. Connect a distributor in Settings for live blank costs.'

        $('#q-verdict', bg).innerHTML = `<div class="qverdict ${v.level}">
          <span class="qv-label">${v.label}</span>
          <span class="qv-vph">${money(vph)}/productive hour</span>
          ${m.margin < 25 ? `<div class="qv-warn">${m.margin < 0
            ? 'This job loses money. Raise the price or walk away.'
            : 'Under 25% is the danger zone. Raise the price or the quantity.'}</div>` : ''}</div>`

        $('#q-break', bg).innerHTML = `
          <div><span>Garment (${money(state.garmentCost)} × ${state.markup})</span><span>${money(q.garment)}</span></div>
          <div><span>Imprint — ${q.totalColors} color${q.totalColors === 1 ? '' : 's'}${q.underbase ? ' (incl. underbase)' : ''}</span><span>${money(q.imprintPerPiece)}</span></div>
          ${q.rushApplied ? `<div style="color:var(--amber)"><span>Rush +${Math.round((q.rushMult - 1) * 100)}%</span><span>included</span></div>` : ''}
          <div class="qline"><span>Per piece</span><span>${money(q.perPiece)}</span></div>
          <div><span>${state.qty} pieces</span><span>${money(q.perPiece * state.qty)}</span></div>
          <div><span>Screens (${q.totalColors} × ${money(state.screenFee)})</span><span>${money(q.screens)}</span></div>
          <div class="qline strong"><span>Order total</span><span>${money(q.subtotal)}</span></div>
          <div class="qm-foot">
            <span>${cost.minutes} press min · ${money(cost.effectiveRate)}/hr effective</span>
            <span>${mm.markupPct}% markup = ${mm.marginPct}% margin</span>
          </div>`

        $('#q-breaks', bg).innerHTML = priceBreaks(state).map((b) => {
          const bc = jobCost({ qty: b.qty, colors: colorsPerLoc, garmentCost: state.garmentCost,
            press: state.press, shopRate, utilization, spoilage, screens: b.totalColors, screenCost: 8 })
          const bm = margin(b.subtotal, bc.total)
          return `<div class="qb ${b.qty === state.qty ? 'on' : ''}" data-qty="${b.qty}">
            <span>${b.qty}</span><strong>${money(b.perPiece)}</strong>
            <em class="${marginVerdict(bm.margin).level}">${bm.margin}%</em></div>`
        }).join('')
      }

      const sync = () => {
        state.decoration = $('#q-deco', bg).value
        state.garmentCost = +$('#q-cost', bg).value || 0
        state.markup = +$('#q-markup', bg).value || 1
        state.qty = Math.max(1, +$('#q-qty', bg).value || 1)
        state.screenFee = +$('#q-screen', bg).value || 0
        state.rushMult = +$('#q-rush', bg).value || 1
        state.press = $('#q-press', bg).value
        state.darkGarment = $('#q-dark', bg).checked
        state.widthIn = +$('#q-w', bg).value || 0
        state.heightIn = +$('#q-h', bg).value || 0
        state.patchSizeIn = +$('#q-patch', bg).value || 3
        state.liveEmbroidery = $('#q-live', bg).checked
        drawLocs()
        render()
      }

      for (const id of ['q-cost', 'q-markup', 'q-qty', 'q-screen', 'q-w', 'q-h']) $(`#${id}`, bg).oninput = sync
      for (const id of ['q-deco', 'q-rush', 'q-press', 'q-dark', 'q-patch', 'q-live']) $(`#${id}`, bg).onchange = sync
      $('#q-showcalc', bg).onclick = () => {
        const c = $('#q-calc', bg); const open = c.hidden
        c.hidden = !open
        $('#q-showcalc', bg).textContent = open ? 'Hide the calculation ▴' : 'Show the calculation ▾'
      }

      on($('#q-locs', bg), '[data-lf]', (_e, t) => {
        const i = +t.closest('[data-i]').dataset.i
        const f = t.dataset.lf
        state.locations[i][f] = f === 'colors' ? Math.max(1, +t.value || 1) : t.value
        render()
      }, 'input')
      on($('#q-locs', bg), '[data-rmloc]', (_e, t) => { state.locations.splice(+t.dataset.rmloc, 1); drawLocs(); render() })
      $('#q-addloc', bg).onclick = () => {
        const used = state.locations.map((l) => l.name)
        state.locations.push({ name: LOCS.find((n) => !used.includes(n)) || 'Front', colors: 1 })
        drawLocs(); render()
      }
      on($('#q-breaks', bg), '[data-qty]', (_e, t) => { $('#q-qty', bg).value = t.dataset.qty; sync() })

      $('#q-use', bg).onclick = () => {
        if (isService()) {
          const q = serviceQuote(state.qty)
          onUse({
            description: `${state.decoration} — ${q.svc.basis}`,
            detail: state.rushMult > 1 ? `RUSH +${Math.round((state.rushMult - 1) * 100)}%` : '',
            decoration: state.decoration,
            sizes: { S: 0, M: state.qty, L: 0, XL: 0 },
            unit_price: q.perPiece,
            garment_cost: state.garmentCost,
            taxable: true,
          })
          if (q.fee > 0) onUse({ description: q.svc.feeLabel || 'Setup', detail: 'One-time charge', qty: 1, unit_price: q.fee, taxable: false })
          closeModal()
          toast(`Added at ${money(q.perPiece)}/pc — now spread the ${state.qty} pieces across sizes`)
          return
        }
        const q = quoteScreenPrint(state)
        const desc = state.locations.map((l) => `${l.colors}/0 ${l.name}`).join(' + ')
        onUse({
          description: `Garment — ${desc}`,
          detail: `${state.locations.length} location${state.locations.length > 1 ? 's' : ''}, ${q.totalColors} color${q.totalColors === 1 ? '' : 's'}${q.underbase ? ' incl. underbase' : ''}${q.rushApplied ? `, RUSH +${Math.round((q.rushMult - 1) * 100)}%` : ''}`,
          decoration: 'Screen Print',
          sizes: { S: 0, M: state.qty, L: 0, XL: 0 },
          unit_price: q.perPiece,
          garment_cost: state.garmentCost,
          taxable: true,
        })
        if (q.screens > 0) {
          onUse({ description: `Screen setup — ${q.totalColors} screen${q.totalColors === 1 ? '' : 's'}`,
            detail: 'One-time charge, screens held 12 months', qty: q.totalColors, unit_price: state.screenFee, taxable: false })
        }
        closeModal()
        toast(`Added at ${money(q.perPiece)}/pc — now spread the ${state.qty} pieces across sizes`)
      }

      drawLocs()
      render()
    },
  })
}
