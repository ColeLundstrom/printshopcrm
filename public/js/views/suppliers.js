/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4 */
import { api, $, esc, money, setPage, toast } from '../core.js'
export async function suppliersView() {
  const d = await api.get('/api/suppliers/promo')
  setPage(
    'Supplier connections',
    '<a class="btn ghost" href="#/matrices">Price matrices</a>',
    '<a href="#/setup">Setup</a> /'
  )
  $('#view').innerHTML =
    `<div class="stack production-page"><p>Connect your distributor account, check blank pricing, and refresh shipment information on a job’s purchase orders. Supplier shipments and your receiving counts are separate: a shipped box is not counted until your team receives it.</p>${['ss', 'sanmar'].map((k) => `<section class="card card-b"><h2>${esc(d.services[k].label)}</h2><p>${d.credentials[k] ? 'Credentials saved. Verify access with a product lookup.' : 'Not connected.'}</p><form data-supplier="${k}"><div class="prod-fields">${k === 'ss' ? '<label class="field">Account number<input name="ss_account" class="input" autocomplete="off"></label><label class="field">API key<input name="ss_api_key" class="input" type="password" autocomplete="new-password"></label>' : '<label class="field">SanMar web username<input name="sanmar_user" class="input" autocomplete="off"></label><label class="field">SanMar password<input name="sanmar_pass" class="input" type="password" autocomplete="new-password"></label>'}</div><button class="btn">Save connection</button><p class="dim">Blank fields keep existing credentials.</p></form>${k === 'sanmar' ? '<p>Ask SanMar to enable Web Services / PromoStandards access for your account. Electronic PO submission requires separate onboarding and supplier testing. SanMar POs currently use the manual portal handoff.</p><a href="https://www.sanmar.com/resources/electronicintegration/integrationofferings" target="_blank" rel="noopener">SanMar integration instructions</a>' : '<p>Your S&S account API key is available in My Account. Existing REST catalog and ordering remain available; this lookup and PO status use PromoStandards.</p><a href="https://promostandards.ssactivewear.com/" target="_blank" rel="noopener">S&S services and credentials</a>'}</section>`).join('')}<section class="card card-b"><h2>Check blank prices</h2><form id="supplier-price"><div class="prod-fields"><label class="field">Supplier<select class="input" name="provider"><option value="ss">S&S Activewear</option><option value="sanmar">SanMar</option></select></label><label class="field">Supplier product ID / style<input class="input" name="product_id" maxlength="64" placeholder="e.g. PC61 at SanMar"></label></div><button class="btn">Look up net prices</button></form><div id="supplier-result" aria-live="polite"></div><p class="dim">Net USD blank costs at FOB 1. Quantity breaks are supplier costs, separate from your customer-facing decoration matrices.</p></section></div>`
  for (const f of document.querySelectorAll('[data-supplier]'))
    f.onsubmit = async (e) => {
      e.preventDefault()
      const b = Object.fromEntries([...new FormData(f)].filter(([, v]) => v.trim()))
      try {
        await api.put('/api/settings', b)
        f.reset()
        toast('Credentials saved. Run a lookup to verify access.')
      } catch (err) {
        toast(err.message, true)
      }
    }
  $('#supplier-price').onsubmit = async (e) => {
    e.preventDefault()
    const out = $('#supplier-result')
    out.textContent = 'Checking supplier…'
    try {
      const r = await api.post('/api/suppliers/promo/pricing', Object.fromEntries(new FormData(e.target)))
      out.innerHTML = `<div style="overflow:auto"><table class="tbl"><thead><tr><th>Supplier part</th><th>Color / size</th><th>Quantity breaks · USD</th></tr></thead><tbody>${r.parts.map((p) => `<tr><td>${esc(p.partId)}</td><td>${esc(p.color || '—')} / ${esc(p.size || '—')}</td><td>${p.breaks.map((b) => `${b.minQty}+: ${Number(b.price).toFixed(4)}`).join(' · ')}</td></tr>`).join('')}</tbody></table></div>${r.parts.length ? '' : '<p>No pricing returned for that product. Check the supplier’s product ID and account access.</p>'}`
    } catch (err) {
      out.textContent = err.message
    }
  }
}
