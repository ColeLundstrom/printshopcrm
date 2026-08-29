import { api, $, esc, money, modal, closeModal, toast, on } from '../core.js'
import { sizeTotal, lineAmount, sizeKeys } from '../shared/pricing.js'

/**
 * The price comes from the SERVER, and this file no longer has an opinion about it.
 *
 * `intakeQuote()` used to live here: a third pricing engine beside lib/quickquote.mjs's
 * priceIntake and the manual quote screen. It wrote a bare "RUSH." onto the customer-visible line
 * and charged the standard rate anyway, used a hardcoded $3.20 blank rather than the live
 * distributor cost, and ignored the shop's price book. On a 300-piece 3-day rush it quoted
 * $3,101.00 where the canonical price is $5,705.00 — $1,860 of dropped rush and $744 of engine
 * divergence, on the biggest quoting surface in the product. v1.18.0 and v1.19.0 closed exactly
 * this on the automated paths and in the assistant; this screen was still doing its own maths.
 *
 * /api/ai/intake now returns `priced.items` — the same lines quick quote and Autopilot write.
 */
const pricedSubtotal = (items) => (items || []).reduce((n, i) => n + lineAmount(i, {}), 0)

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
export function intakeModal(onUse) {
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
        const lines = p.priced?.items || []
        const subtotal = pricedSubtotal(lines)
        const perPiece = Number(lines[0]?.unit_price) || 0
        const grid = sizeKeys(p.sizes)

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
            <span>${money(perPiece)}</span><em>per piece · ${money(subtotal)} order</em>
          </div>
          ${p.priced?.quote?.rushApplied ? `<div class="dim" style="font-size:10.5px;margin-top:6px">Rush surcharge applied — +${Math.round((p.priced.quote.rushMult - 1) * 100)}% on the per-piece, at the shop's published tier.</div>` : ''}
          ${p.assumed_pieces ? `<div class="dim" style="font-size:10.5px;margin-top:6px">The message never says how many, so this is priced at <strong>${p.assumed_pieces}</strong> — set the real count on the estimate and it re-prices.</div>` : ''}`
      }

      $('#in-use', bg).onclick = () => {
        if (!parsed) return
        const pieces = sizeTotal(parsed.sizes) || parsed.total_pieces || parsed.assumed_pieces || 24
        const lines = parsed.priced?.items || []
        if (!lines.length) return toast('That message could not be priced — open a blank estimate instead', true)
        // The server's lines, verbatim: the garment line (with its size grid, colour count, blank
        // source and the rush surcharge already in the per-piece) plus whatever setup line this
        // decoration actually bills — screens for screen print, digitizing for embroidery, none
        // for DTF. `parsed` rides along on the first one so the caller can pull the notes across.
        lines.forEach((line, i) => onUse({ ...line }, i === 0 ? parsed : null))
        closeModal()
        toast(`Read ${pieces} pieces from the message — check it before you send`)
      }
    },
  })
}
