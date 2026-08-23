import { api, $, esc, money, modal, closeModal, toast, on } from '../core.js'
import { SIZES, sizeSummary, sizeTotal, quoteScreenPrint, round2 } from '../shared/pricing.js'
import { servicePerPiece, SERVICE_METHODS } from '../shared/servicecost.js'

/** Price a parsed intake by its actual decoration — screen print uses the screen engine, everything
 *  else uses the real per-service cost model. Returns a uniform shape for the preview + commit. */
function intakeQuote(p, pieces, settings) {
  const garmentCost = p.garment_cost || 3.2
  const markup = Number(settings.default_markup) || 2
  if (SERVICE_METHODS.includes(p.decoration)) {
    const svc = servicePerPiece(p.decoration, pieces, {})
    const perPiece = round2(garmentCost * markup + svc.sell)
    return { perPiece, subtotal: round2(perPiece * pieces + (svc.fee || 0)), screens: 0, totalColors: 0, isService: true, fee: svc.fee || 0, feeLabel: svc.feeLabel }
  }
  const q = quoteScreenPrint({ garmentCost, markup, qty: pieces || 24, locations: p.locations || [{ name: 'Front', colors: 1 }], screenFee: Number(settings.screen_fee) || 25, darkGarment: p.dark_garment })
  return { perPiece: q.perPiece, subtotal: q.subtotal, screens: q.screens, totalColors: q.totalColors, isService: false }
}

/**
 * Paste-an-email intake.
 *
 * The researched bottleneck is the front office, not the press: "Manual order entry.
 * Email-based artwork approvals. Shared spreadsheets." This turns the email a customer
 * actually sends into a priced draft with the size grid filled in.
 *
 * It never blocks on a model. The deterministic parser does the real work; the model only
 * adds polish when it's reachable, and the UI says plainly which one you're looking at.
 */
export function intakeModal(settings, onUse) {
  const SAMPLE = `Hi — we're doing shirts for the fall festival this year.

Looking at 24 S, 60 M, 80 L, 36 XL and 12 2XL. Gildan 5000 in black.
Two color front and a one color back, same art as last time.

Need them by Oct 12 if that's doable. What's the damage?

Thanks,
Alexis`

  modal({
    title: 'Read an order from an email',
    wide: true,
    body: `<div class="quote">
      <div class="quote-in">
        <div class="field"><label>Paste the customer's message</label>
          <textarea class="input" id="in-text" style="min-height:230px;font-size:13px" placeholder="Paste an email, a text, a DM…"></textarea>
        </div>
        <div class="wrap-row">
          <button class="btn" id="in-read">Read it</button>
          <button class="btn ghost sm" id="in-sample">Use a sample</button>
          <div class="sp"></div>
          <span class="dim" id="in-status" style="font-size:11px"></span>
        </div>
      </div>
      <div class="quote-out" id="in-out">
        <div class="dim" style="text-align:center;padding:40px 10px;font-size:12.5px">
          Paste a message and hit <strong>Read it</strong>.<br><br>
          It pulls out the size run, colours, garment and dates so you're not retyping an email into a form.
        </div>
      </div>
    </div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="in-use" disabled>Add to estimate</button>`,
    onMount: (bg) => {
      let parsed = null

      api.get('/api/ai/status').then((s) => {
        $('#in-status', bg).innerHTML = s.available
          ? `<span style="color:var(--accent)">● model connected</span>`
          : `<span style="color:var(--txt-3)" title="${esc(s.reason || '')}">● parser only — model offline</span>`
      }).catch(() => {})

      $('#in-sample', bg).onclick = () => { $('#in-text', bg).value = SAMPLE; $('#in-read', bg).click() }

      $('#in-read', bg).onclick = async () => {
        const text = $('#in-text', bg).value.trim()
        if (text.length < 8) return toast('Paste the message first', true)
        $('#in-read', bg).disabled = true
        $('#in-out', bg).innerHTML = '<div class="dim" style="text-align:center;padding:44px">Reading…</div>'
        try {
          parsed = await api.post('/api/ai/intake', { text })
          render(parsed)
          $('#in-use', bg).disabled = false
        } catch (e) {
          toast(e.message, true)
          $('#in-out', bg).innerHTML = `<div class="dim" style="padding:30px;text-align:center">${esc(e.message)}</div>`
        } finally { $('#in-read', bg).disabled = false }
      }

      const render = (p) => {
        const pieces = sizeTotal(p.sizes) || p.total_pieces || 0
        const q = intakeQuote(p, pieces, settings)
        const grid = SIZES.filter((s) => Number(p.sizes?.[s]) > 0)

        $('#in-out', bg).innerHTML = `
          <div class="row" style="justify-content:space-between;margin-bottom:10px">
            <strong style="font-size:12.5px">What it read</strong>
            <span class="pill ${p.source === 'model' ? 'violet' : 'gray'}">${p.source === 'model' ? 'model' : 'parser'}</span>
          </div>
          ${p.ai_note ? `<div class="dim" style="font-size:10.5px;margin-bottom:9px;line-height:1.4">${esc(p.ai_note)}</div>` : ''}
          <div class="qbreak">
            <div><span>Garment</span><span>${esc(p.garment)}</span></div>
            <div><span>Decoration</span><span>${esc(p.decoration)}</span></div>
            <div><span>Locations</span><span>${(p.locations || []).map((l) => `${l.colors}c ${esc(l.name)}`).join(', ')}</span></div>
            ${p.dark_garment ? '<div><span>Dark garment</span><span style="color:var(--amber)">underbase added</span></div>' : ''}
            ${p.rush ? '<div><span>Rush</span><span style="color:var(--red)">flagged</span></div>' : ''}
            ${p.due_hint ? `<div><span>Wants it by</span><span>${esc(p.due_hint)}</span></div>` : ''}
          </div>
          <div style="margin-top:11px">
            <div class="dim" style="font-size:9.5px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:5px">Size run — ${pieces} pcs</div>
            ${grid.length ? `<div class="sizebar">${grid.map((s) => `<div class="sizebox"><span>${s}</span><strong>${p.sizes[s]}</strong></div>`).join('')}</div>`
              : `<div class="dim" style="font-size:11.5px">No size breakdown in the message${pieces ? ` — just "${pieces} pieces". You'll split it.` : ''}</div>`}
          </div>
          <div class="qbig" style="margin-top:14px;border-top:1px solid var(--line);border-bottom:0;padding-top:12px">
            <span>${money(q.perPiece)}</span><em>per piece · ${money(q.subtotal)} order</em>
          </div>`
      }

      $('#in-use', bg).onclick = () => {
        if (!parsed) return
        const pieces = sizeTotal(parsed.sizes) || parsed.total_pieces || 24
        const q = intakeQuote(parsed, pieces, settings)
        const sizes = Object.keys(parsed.sizes || {}).length
          ? parsed.sizes
          : { S: 0, M: pieces, L: 0, XL: 0 } // no grid given — park it on M for the shop to split
        const locDesc = q.isService
          ? parsed.decoration
          : (parsed.locations || []).map((l) => `${l.colors}/0 ${l.name}`).join(' + ')
        onUse({
          description: `${parsed.garment} — ${locDesc}`,
          detail: `${parsed.dark_garment ? 'Dark garment, underbase incl. ' : ''}${parsed.rush ? 'RUSH. ' : ''}${parsed.notes || ''}`.trim().slice(0, 140),
          decoration: parsed.decoration,
          sizes,
          unit_price: q.perPiece,
          garment_cost: parsed.garment_cost,
          taxable: true,
        }, parsed)
        if (q.screens > 0) {
          onUse({ description: `Screen setup — ${q.totalColors} screen${q.totalColors === 1 ? '' : 's'}`,
            detail: 'One-time charge', qty: q.totalColors, unit_price: Number(settings.screen_fee) || 25, taxable: false })
        }
        if (q.isService && q.fee > 0) {
          onUse({ description: q.feeLabel || `${parsed.decoration} setup`,
            detail: 'One-time charge', qty: 1, unit_price: q.fee, taxable: false })
        }
        closeModal()
        toast(`Read ${pieces} pieces from the message — check it before you send`)
      }
    },
  })
}
