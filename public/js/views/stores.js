import { api, $, $$, esc, money, setPage, toast, go, on, confirmModal, empty, copyText, fmtDate } from '../core.js'
import { customerPicker } from '../shared/customer-picker.js'

/**
 * Merch stores — an online team store the shop opens for one customer (lib/merch-stores.mjs).
 *
 * The shop picks who it is for, names it, sets a close date and the products with their price and
 * sizes, and gets one link to send the coach. Members order on their own; the shop watches the
 * orders arrive here and turns the lot into ONE estimate with the size runs already added up.
 */

// The sizes a team store usually offers, in the order a person reads them. The rest are one click away.
const COMMON = ['YS', 'YM', 'YL', 'S', 'M', 'L', 'XL', '2XL', '3XL']
const MORE = ['YXS', 'YXL', 'XS', '4XL', '5XL', '6XL', 'LT', 'XLT', '2XLT', '3XLT', '4XLT', 'OSFA']
const ALL_SIZES = [...COMMON, ...MORE]
const ORDER = ['YXS', 'YS', 'YM', 'YL', 'YXL', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', 'LT', 'XLT', '2XLT', '3XLT', '4XLT', 'OSFA']

const blankProduct = (name = '', price = '') => ({ name, price, description: '', image_url: '', sizes: ['S', 'M', 'L', 'XL', '2XL'], more: false })
let liveTimer = null

/* ---------------- list ---------------- */

export async function storesView() {
  clearInterval(liveTimer)
  if (/[?&]new=1\b/.test(location.hash)) return newStoreForm()
  setPage('Merch stores', '<button class="btn primary" id="st-new" type="button">+ New store</button>')
  $('#st-new').onclick = () => newStoreForm()
  const { stores } = await api.get('/api/stores')
  if (!stores.length) {
    $('#view').innerHTML = `<div class="st-hero">${empty('products', 'Open a team store', 'Share one link with a team, a school or an office. Everyone picks their own item and size. When it closes you get one order with every size added up.',
      '<button class="btn primary big" id="st-first" type="button">Open your first store</button>')}</div>`
    $('#st-first').onclick = () => newStoreForm()
    return
  }
  $('#view').innerHTML = `<div class="st-list" id="st-list">${stores.map((s) => `
    <a class="st-card" href="#/stores/${s.id}">
      <div class="st-card-top"><span class="st-name">${esc(s.name)}</span>${statusPill(s)}</div>
      <div class="st-for">${esc(s.contact?.name || 'Customer removed')}${s.contact?.company ? ` · ${esc(s.contact.company)}` : ''}</div>
      <div class="st-stats">
        <span><strong>${s.order_count}</strong> order${s.order_count === 1 ? '' : 's'}</span>
        <span><strong>${money(s.order_total)}</strong></span>
        <span>${s.close_date ? `${s.is_open ? 'Closes' : 'Closed'} ${esc(fmtDate(s.close_date))}` : 'No close date'}</span>
      </div>
    </a>`).join('')}</div>`
}

const statusPill = (s) => s.estimate_id ? '<span class="pill blue">Estimated</span>' : s.is_open ? '<span class="pill green">Open</span>' : '<span class="pill gray">Closed</span>'

/* ---------------- new store ---------------- */

function newStoreForm() {
  clearInterval(liveTimer)
  const st = { contact: null, name: '', close_date: '', message: '', products: [blankProduct('T-shirt')] }
  setPage('Open a team store', '', '<a href="#/stores">Merch stores</a> /')
  $('#view').innerHTML = `<div class="guide st-new">
    <div class="guide-card"><h2 class="guide-q">Who is the store for?</h2>
      <p class="guide-hint">The team, school or company you will bill when the store closes.</p>
      <div id="st-who"></div></div>
    <div id="st-rest"></div></div>`
  const pick = (c) => { st.contact = c; drawWho(); drawRest() }
  const drawWho = () => {
    const who = $('#st-who')
    if (!st.contact) { customerPicker(who, pick).catch((e) => toast(e.message, true)); return }
    who.innerHTML = `<div class="guide-who">For <strong>${esc(st.contact.name)}</strong>${st.contact.company ? ` · ${esc(st.contact.company)}` : ''} <button type="button" class="linkbtn" id="st-change">Change</button></div>`
    $('#st-change').onclick = () => { st.contact = null; drawWho(); $('#st-rest').innerHTML = '' }
  }
  const drawRest = () => {
    const rest = $('#st-rest')
    rest.innerHTML = `<form class="guide-card st-form" id="st-form" novalidate>
      <h2 class="guide-q">Name it and set a close date</h2>
      <div class="grid2">
        <div class="field"><label for="st-name">Store name *</label><input class="input" id="st-name" maxlength="120" placeholder="e.g. Eagles Soccer Spring Gear" value="${esc(st.name || `${st.contact.company || st.contact.name} store`)}"></div>
        <div class="field"><label for="st-close">Orders close on</label><input class="input" id="st-close" type="date" value="${esc(st.close_date)}"></div>
      </div>
      <div class="field"><label for="st-msg">Message to members</label><textarea class="input" id="st-msg" rows="2" maxlength="2000" placeholder="Order by Friday. Shirts handed out at practice.">${esc(st.message)}</textarea></div>
      <h2 class="guide-q">What can they order?</h2>
      <p class="guide-hint">Set one price per item. Tick the sizes they can pick.</p>
      <div id="st-products" class="st-products"></div>
      <button type="button" class="btn ghost" id="st-add">+ Add another item</button>
      <div class="guide-row"><span class="spacer"></span><button class="btn primary big" type="submit" id="st-create">Open the store →</button></div>
    </form>`
    drawProducts()
    const form = $('#st-form')
    // Bound on the form, which this function creates afresh — #st-products is redrawn in place.
    on(form, '[data-size]', (_e, b) => { const on1 = !b.classList.contains('on'); b.classList.toggle('on', on1); b.setAttribute('aria-pressed', String(on1)) })
    on(form, '[data-more]', (_e, b) => { readProducts(); st.products[+b.dataset.more].more = true; drawProducts() })
    on(form, '[data-del]', (_e, b) => { readProducts(); st.products.splice(+b.dataset.del, 1); drawProducts() })
    const sync = () => { st.name = $('#st-name').value; st.close_date = $('#st-close').value; st.message = $('#st-msg').value }
    form.addEventListener('input', sync)
    $('#st-add').onclick = () => { readProducts(); st.products.push(blankProduct()); drawProducts(); $$('.st-prod .st-pname').at(-1)?.focus() }
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      sync(); readProducts()
      if (!st.name.trim()) { toast('Give the store a name', true); $('#st-name').focus(); return }
      const btn = $('#st-create'); btn.disabled = true
      try {
        const s = await api.post('/api/stores', {
          contact_id: st.contact.id, name: st.name, close_date: st.close_date || null, message: st.message,
          products: st.products.map((p) => ({ name: p.name, price: p.price === '' ? NaN : Number(p.price), description: p.description, image_url: p.image_url, sizes: p.sizes })),
        })
        toast('Store is open — copy the link and send it')
        go(`/stores/${s.id}`)
      } catch (err) { toast(err.message, true); btn.disabled = false }
    })
  }
  const readProducts = () => {
    for (const row of $$('.st-prod')) {
      const p = st.products[+row.dataset.i]
      if (!p) continue
      p.name = $('.st-pname', row).value
      p.price = $('.st-pprice', row).value
      p.description = $('.st-pdesc', row).value
      p.image_url = $('.st-pimg', row).value.trim()
      p.sizes = ORDER.filter((s) => $$('.choice.on', row).some((b) => b.dataset.size === s))
    }
  }
  const drawProducts = () => {
    const box = $('#st-products')
    box.innerHTML = st.products.map((p, i) => `<div class="st-prod" data-i="${i}">
      <div class="st-prod-h"><span class="st-num">${i + 1}</span>
        <input class="input st-pname" aria-label="Item name" maxlength="120" placeholder="Item name (e.g. Team hoodie)" value="${esc(p.name)}">
        <label class="st-price-in"><span class="sr-only">Price per piece</span><input class="input st-pprice" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Price" value="${esc(p.price)}"></label>
        ${st.products.length > 1 ? `<button type="button" class="st-del" data-del="${i}" aria-label="Remove ${esc(p.name || 'item')}">×</button>` : ''}
      </div>
      <div class="choice-row st-sizes">${(p.more ? ALL_SIZES : COMMON.concat(MORE.filter((s) => p.sizes.includes(s)))).map((s) => `<button type="button" class="choice${p.sizes.includes(s) ? ' on' : ''}" data-size="${s}" aria-pressed="${p.sizes.includes(s)}">${s}</button>`).join('')}
        ${p.more ? '' : `<button type="button" class="linkbtn" data-more="${i}">More sizes</button>`}</div>
      <details class="st-extra"${p.description || p.image_url ? ' open' : ''}><summary>Description and picture (optional)</summary>
        <div class="grid2"><input class="input st-pdesc" maxlength="500" placeholder="Gildan 5000, navy, 1-color front" value="${esc(p.description)}" aria-label="Description">
        <input class="input st-pimg" type="url" placeholder="Picture link (https://…)" value="${esc(p.image_url)}" aria-label="Picture link"></div></details>
    </div>`).join('')
  }
  drawWho()
  // A link from the customer's page (?contact=<id>) skips the picker.
  const cid = Number((/[?&]contact=(\d+)/.exec(location.hash) || [])[1])
  if (cid) api.get(`/api/contacts/${cid}`).then((c) => c?.id && pick(c)).catch(() => {})
}

/* ---------------- detail ---------------- */

export async function storeDetailView(id) {
  clearInterval(liveTimer)
  const here = location.hash
  const s = await api.get(`/api/stores/${id}`)
  draw(s)
  // Orders arrive while the shop watches: refresh quietly every 20s while this screen is open.
  liveTimer = setInterval(async () => {
    if (location.hash !== here || !$('#st-detail')) { clearInterval(liveTimer); return }
    try { const fresh = await api.get(`/api/stores/${id}`); if (fresh.order_count !== s.order_count || fresh.status !== s.status) { Object.assign(s, fresh); draw(s) } } catch { /* next tick */ }
  }, 20000)
}

function draw(s) {
  const sum = s.summary
  const sizes = ORDER.filter((z) => sum.products.some((p) => p.sizes[z])).concat([...new Set(sum.products.flatMap((p) => Object.keys(p.sizes)))].filter((z) => !ORDER.includes(z)))
  const canEstimate = !s.estimate_id && s.order_count > 0
  setPage(s.name, `${s.estimate_id ? `<a class="btn primary" href="#/estimates/${s.estimate_id}">Open estimate</a>` : `<button class="btn primary" id="st-est" type="button"${canEstimate ? '' : ' disabled title="Nobody has ordered yet"'}>Turn into estimate</button>`}
    ${s.is_open ? '<button class="btn ghost" id="st-close" type="button">Close store</button>' : s.estimate_id ? '' : '<button class="btn ghost" id="st-reopen" type="button">Reopen</button>'}
    <button class="btn danger" id="st-delete" type="button">Delete</button>`, '<a href="#/stores">Merch stores</a> /')

  $('#view').innerHTML = `<div class="st-detail" id="st-detail">
    <div class="st-share card">
      <div class="st-share-t"><div><div class="st-share-h">${statusPill(s)} <span>${s.is_open ? 'Send this link to the team' : 'This store is closed to new orders'}</span></div>
        <div class="st-for">For <a href="#/contacts/${s.contact_id}">${esc(s.contact?.name || 'Customer removed')}</a>${s.close_date ? ` · ${s.is_open ? 'closes' : 'closed'} ${esc(fmtDate(s.close_date))}` : ''}</div></div></div>
      <div class="copy-row st-copy"><input class="input" id="st-url" readonly value="${esc(s.share_url)}" aria-label="Store link">
        <button class="btn primary" type="button" id="st-copy">Copy link</button>
        <a class="btn ghost" href="${esc(s.share_url)}" target="_blank" rel="noopener">Open</a></div>
      ${s.message ? `<p class="st-message">${esc(s.message)}</p>` : ''}
    </div>
    <div class="kpis st-kpis">
      <div class="kpi"><div class="lbl">Orders</div><div class="val">${sum.orders}</div><div class="sub">people ordered</div></div>
      <div class="kpi"><div class="lbl">Pieces</div><div class="val">${sum.units}</div><div class="sub">to print</div></div>
      <div class="kpi info"><div class="lbl">Store total</div><div class="val">${money(sum.total)}</div><div class="sub">at store prices</div></div>
      <div class="kpi"><div class="lbl">Items</div><div class="val">${s.products.length}</div><div class="sub">on offer</div></div>
    </div>
    <div class="card st-sec"><div class="card-h"><h3>What to print</h3><span class="spacer"></span><span class="dim">Every order added up</span></div>
      ${sum.products.length ? `<div class="st-scroll"><table class="tbl st-matrix"><thead><tr><th>Item</th>${sizes.map((z) => `<th class="num">${esc(z)}</th>`).join('')}<th class="num">Pieces</th><th class="num">Total</th></tr></thead><tbody>
        ${sum.products.map((p) => `<tr><td><strong>${esc(p.name)}</strong><div class="dim">${money(p.price)} each</div></td>${sizes.map((z) => `<td class="num">${p.sizes[z] || '<span class="dim">–</span>'}</td>`).join('')}<td class="num"><strong>${p.units}</strong></td><td class="num">${money(p.total)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="card-b dim">Nothing yet. Orders show up here the moment someone places one.</div>'}
    </div>
    <div class="card st-sec"><div class="card-h"><h3>Orders</h3><span class="spacer"></span><span class="dim">${s.is_open ? 'Updates on its own' : ''}</span></div>
      ${s.orders.length ? `<div class="st-scroll"><table class="tbl st-orders"><thead><tr><th>Who</th><th>Ordered</th><th class="num">Total</th><th>When</th><th></th></tr></thead><tbody>
        ${s.orders.map((o) => `<tr><td><strong>${esc(o.name)}</strong><div class="dim">${esc(o.email)}</div>${o.note ? `<div class="st-note">${esc(o.note)}</div>` : ''}</td>
          <td>${o.items.map((i) => `<span class="st-line">${esc(i.name)} · ${esc(i.size)} × ${i.qty}</span>`).join('')}</td>
          <td class="num">${money(o.total)}</td><td class="dim">${esc(fmtDate(o.created_at))}</td>
          <td class="num">${s.estimate_id ? '' : `<button class="btn ghost sm" type="button" data-rm="${o.id}" aria-label="Remove ${esc(o.name)}'s order">Remove</button>`}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="card-b">${empty('orders', 'No orders yet', 'Copy the link above and send it to the coach or organiser. Members order on their phone — no account needed.')}</div>`}
    </div></div>`

  $('#st-copy').onclick = () => copyText(s.share_url, 'Store link copied')
  const reload = () => storeDetailView(s.id)
  const est = $('#st-est')
  if (est) est.onclick = () => confirmModal('Turn into estimate?', `This makes one draft estimate for ${s.contact?.name || 'the customer'} with ${sum.units} pieces across ${sum.products.length} item${sum.products.length === 1 ? '' : 's'}, and closes the store to new orders.`, async () => {
    try { const r = await api.post(`/api/stores/${s.id}/estimate`, {}); toast(`Estimate ${r.estimate_number} created`); go(`/estimates/${r.estimate_id}`) } catch (e) { toast(e.message, true) }
  }, 'Make the estimate')
  const close = $('#st-close')
  if (close) close.onclick = () => confirmModal('Close this store?', 'Members will see “This store is closed” and cannot order any more. You can reopen it later.', async () => {
    try { await api.post(`/api/stores/${s.id}/close`, {}); toast('Store closed'); reload() } catch (e) { toast(e.message, true) }
  }, 'Close store')
  const reopen = $('#st-reopen')
  if (reopen) reopen.onclick = async () => {
    try {
      const today = new Date().toISOString().slice(0, 10)
      await api.put(`/api/stores/${s.id}`, { status: 'open', ...(s.close_date && s.close_date < today ? { close_date: null } : {}) })
      toast('Store reopened'); reload()
    } catch (e) { toast(e.message, true) }
  }
  $('#st-delete').onclick = () => confirmModal('Delete this store?', `The link stops working and its ${s.order_count} order${s.order_count === 1 ? '' : 's'} are deleted. An estimate already made from it is kept.`, async () => {
    try { await api.del(`/api/stores/${s.id}`); toast('Store deleted'); go('/stores') } catch (e) { toast(e.message, true) }
  })
  on($('#st-detail'), '[data-rm]', (_e, b) => confirmModal('Remove this order?', 'It comes off the totals. The person is not told.', async () => {
    try { await api.del(`/api/stores/${s.id}/orders/${b.dataset.rm}`); toast('Order removed'); reload() } catch (e) { toast(e.message, true) }
  }, 'Remove'))
}
