/* Setup & connections → Shipping labels: the shop's own label account, where parcels ship from,
 * and who may spend postage. The key is write-only: the server never sends it back. */
import { api, esc, $, setPage, toast, confirmModal } from '../core.js'

const field = (label, id, value = '', extra = '') => `<label class="field" for="${id}">${esc(label)}<input class="input" id="${id}" value="${esc(value)}" ${extra}></label>`

export async function shippingLabelsSetupView() {
  setPage('Shipping labels', '', '<a href="#/setup">Setup & connections</a>')
  let s
  try { s = await api.get('/api/shipping/labels/setup') } catch (e) { $('#view').innerHTML = `<div class="card card-b"><p role="alert">${esc(e.message)}</p></div>`; return }
  if (!s.manager) { $('#view').innerHTML = '<div class="card card-b"><p>Only a manager can set up shipping labels.</p></div>'; return }
  const f = s.ship_from, d = s.parcel_default
  const mode = s.key_mode === 'test' ? '<span class="tag label-test">TEST key</span> Labels are samples and cost nothing.' : s.key_mode === 'production' ? '<span class="tag green">Live key</span> Labels cost real postage.' : ''
  $('#view').innerHTML = `<div class="label-setup">
    <div class="card card-b">
      <h2>Your label account</h2>
      <p class="dim">Labels are bought on your own <a href="${esc(s.signup_url)}" target="_blank" rel="noopener noreferrer">EasyPost</a> account at your own rates, across USPS, UPS, FedEx and the other carriers you enable there. PrintShopCRM adds nothing to the price. Start with EasyPost’s <strong>test</strong> key: it makes sample labels and cannot spend money.</p>
      <p role="status">${s.connected ? `Connected. ${mode}` : 'Not connected.'}</p>
      ${field(s.connected ? 'Replace API key (leave blank to keep the saved one)' : 'EasyPost API key', 'label-key', '', 'type="password" autocomplete="off" spellcheck="false" placeholder="EZTK… or EZAK…"')}
      <div class="shipment-actions">
        <button class="btn ghost" type="button" id="label-test" ${s.connected ? '' : 'disabled'}>Test connection</button>
        ${s.connected ? '<button class="btn ghost" type="button" id="label-disconnect">Disconnect</button>' : ''}
        <span class="dim" id="label-test-note" role="status"></span>
      </div>
    </div>
    <div class="card card-b">
      <h2>Ship from</h2>
      <p class="dim">The return address printed on every label, and where carriers price from.</p>
      <div class="shipment-fields">
        ${field('Company', 'lf-company', f.company, 'maxlength="80"')}${field('Contact name (optional)', 'lf-name', f.name, 'maxlength="80"')}
        ${field('Street address', 'lf-street1', f.street1, 'maxlength="100"')}${field('Suite, unit (optional)', 'lf-street2', f.street2, 'maxlength="100"')}
        ${field('City', 'lf-city', f.city, 'maxlength="60"')}${field('State', 'lf-state', f.state, 'maxlength="2" placeholder="TX"')}
        ${field('ZIP / postal code', 'lf-zip', f.zip, 'maxlength="12"')}${field('Country', 'lf-country', f.country || 'US', 'maxlength="2"')}
        ${field('Phone', 'lf-phone', f.phone, 'maxlength="30"')}${field('Email (optional)', 'lf-email', f.email, 'maxlength="120"')}
      </div>
    </div>
    <div class="card card-b">
      <h2>Usual box</h2>
      <p class="dim">Prefills the box when you create a label. The last box you rated is remembered too.</p>
      <div class="label-box">
        ${field('Weight (lb)', 'lp-weight_lb', d.weight_lb || '', 'inputmode="decimal"')}${field('oz', 'lp-weight_oz', d.weight_oz || '', 'inputmode="decimal"')}
        ${field('Length (in)', 'lp-length', d.length || '', 'inputmode="decimal"')}${field('Width', 'lp-width', d.width || '', 'inputmode="decimal"')}${field('Height', 'lp-height', d.height || '', 'inputmode="decimal"')}
      </div>
      <label class="label-check"><input type="checkbox" id="label-staff" ${s.staff_can_buy ? 'checked' : ''}> Staff can buy labels on shipping tasks assigned to them. Managers always can.</label>
    </div>
    <div class="shipment-actions"><button class="btn" type="button" id="label-save">Save shipping label settings</button><a class="btn ghost" href="#/setup">Back to setup</a></div>
    <p class="dim">Buying a label saves its tracking number to the job’s shipments. It does not move the job, mark it shipped or email the customer — those stay your call. See docs/SHIPPING.md.</p>
  </div>`
  const v = (id) => $(`#${id}`).value.trim()
  $('#label-save').onclick = async () => {
    const btn = $('#label-save'); btn.disabled = true
    try {
      const from = Object.fromEntries(['company', 'name', 'street1', 'street2', 'city', 'state', 'zip', 'country', 'phone', 'email'].map((k) => [k, v(`lf-${k}`)]))
      await api.put('/api/shipping/labels/setup', {
        api_key: v('label-key'),
        // A key can be saved on its own first; the address is checked once any of it is filled in.
        ...(from.street1 || from.city || from.zip ? { ship_from: from } : {}),
        parcel_default: Object.fromEntries(['weight_lb', 'weight_oz', 'length', 'width', 'height'].map((k) => [k, v(`lp-${k}`)])),
        staff_can_buy: $('#label-staff').checked,
      })
      toast('Shipping label settings saved')
      shippingLabelsSetupView()
    } catch (e) { toast(e.message, true); btn.disabled = false }
  }
  $('#label-test').onclick = async () => {
    const btn = $('#label-test'), note = $('#label-test-note'); btn.disabled = true; note.textContent = 'Checking…'
    try { const r = await api.post('/api/shipping/labels/setup/test', {}); note.textContent = r.message } catch (e) { note.textContent = e.message } finally { btn.disabled = false }
  }
  if ($('#label-disconnect')) $('#label-disconnect').onclick = () => confirmModal('Disconnect shipping labels?',
    'This removes the saved API key. Labels you already bought stay on their jobs; you will not be able to buy, track or void labels until you connect again.',
    async () => { try { await api.post('/api/shipping/labels/setup/disconnect', {}); toast('Shipping labels disconnected'); shippingLabelsSetupView() } catch (e) { toast(e.message, true) } }, 'Disconnect')
}
