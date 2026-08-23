import { nest, priceSheet, round2 } from '/js/shared/gangnest.js'

/**
 * The embeddable DTF gang-sheet builder — this runs on the SHOP's website (in an iframe),
 * for the shop's own customers. Upload designs, size them, watch them nest onto the roll live,
 * see the price, and check out through the shop's own Stripe. Deliberately dead-simple.
 */

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`
const PPI = 22 // canvas pixels per inch for the preview

let cfg = { shop: 'Print Shop', dtf: { sheetWidth: 22, pricePerInch: 0.95, minCharge: 10 }, checkout: 'quote' }
const designs = [] // { url, img, wIn, qty, name }
// Which shop this widget belongs to (its embed key), read from the iframe URL.
const SHOP = new URLSearchParams(location.search).get('shop') || ''
const shopQ = SHOP ? `?shop=${encodeURIComponent(SHOP)}` : ''

async function boot() {
  // A customer coming back from Stripe has already paid — show them that first. Confirming the
  // payment must never depend on the config request, or a transient config failure tells someone
  // who was just charged that the builder is unavailable.
  const p = new URLSearchParams(location.search)
  if (p.get('paid')) return done('paid')
  if (p.get('canceled')) history.replaceState(null, '', location.pathname)
  // An unknown / missing shop key answers 404 with a JSON error body, which would overwrite the
  // defaults and leave render() throwing into an empty iframe on the shop's own site.
  try {
    const r = await fetch(`/api/embed/config${shopQ}`)
    const d = await r.json()
    if (!r.ok || !d?.dtf) throw new Error(d?.error || 'config unavailable')
    cfg = d
  } catch (e) {
    document.getElementById('gs-root').innerHTML = `<div class="gs"><div class="gs-done"><h2>Builder unavailable</h2><p>${esc(e.message)}</p></div></div>`
    return
  }
  render()
}

function render() {
  const root = document.getElementById('gs-root')
  root.innerHTML = `
    <div class="gs">
      <div class="gs-head">
        <div><div class="gs-title">DTF Gang Sheet Builder</div><div class="gs-sub">${esc(cfg.shop)} · ${cfg.dtf.sheetWidth}" roll</div></div>
        <div class="gs-price" id="gs-price"></div>
      </div>
      <div class="gs-body">
        <div class="gs-left">
          <div class="gs-drop" id="gs-drop">
            <div class="gs-drop-ic">⬆</div>
            <div><strong>Drop your designs here</strong><span>or click to upload — PNG with transparency works best</span></div>
          </div>
          <input type="file" id="gs-file" accept="image/*" multiple hidden>
          <div class="gs-list" id="gs-list"></div>
        </div>
        <div class="gs-right">
          <div class="gs-sheet-wrap"><div class="gs-sheet-lbl" id="gs-sheet-lbl"></div>
            <canvas id="gs-canvas"></canvas></div>
        </div>
      </div>
      <div class="gs-foot" id="gs-foot"></div>
    </div>`

  const drop = document.getElementById('gs-drop')
  const file = document.getElementById('gs-file')
  drop.onclick = () => file.click()
  file.onchange = (e) => addFiles(e.target.files)
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over') }
  drop.ondragleave = () => drop.classList.remove('over')
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files) }
  draw()
}

function addFiles(files) {
  ;[...files].filter((f) => f.type.startsWith('image/')).forEach((f) => {
    const img = new Image()
    img.onload = () => { designs.push({ url: img.src, img, wIn: Math.min(11, round2(Math.max(2, img.width / 150))), qty: 1, name: f.name }); draw(); list() }
    img.src = URL.createObjectURL(f)
  })
}

function list() {
  document.getElementById('gs-list').innerHTML = designs.map((d, i) => `
    <div class="gs-item">
      <div class="gs-thumb"><img src="${d.url}"></div>
      <div class="gs-item-b">
        <div class="gs-item-n">${esc(d.name || 'design')}</div>
        <div class="gs-item-ctl">
          <label>Width <input type="number" min="1" max="${cfg.dtf.sheetWidth}" step="0.5" value="${d.wIn}" data-w="${i}">in</label>
          <label>Qty <input type="number" min="1" max="200" value="${d.qty}" data-q="${i}"></label>
          <button class="gs-del" data-del="${i}">✕</button>
        </div>
      </div>
    </div>`).join('')
  document.querySelectorAll('[data-w]').forEach((el) => el.oninput = () => { designs[+el.dataset.w].wIn = Math.max(0.5, +el.value || 1); draw() })
  document.querySelectorAll('[data-q]').forEach((el) => el.oninput = () => { designs[+el.dataset.q].qty = Math.max(1, +el.value || 1); draw() })
  document.querySelectorAll('[data-del]').forEach((el) => el.onclick = () => { designs.splice(+el.dataset.del, 1); draw(); list() })
}

function computed() {
  const items = designs.map((d) => ({ w: d.wIn, h: round2(d.wIn * (d.img.height / d.img.width)), qty: d.qty, i: designs.indexOf(d) }))
  const n = nest(items, { sheetWidth: cfg.dtf.sheetWidth })
  const price = priceSheet(n.usedHeight, cfg.dtf)
  return { items, n, price }
}

function draw() {
  const { n, price } = computed()
  const c = document.getElementById('gs-canvas'); if (!c) return
  const W = cfg.dtf.sheetWidth * PPI
  const H = Math.max(6, n.usedHeight) * PPI
  c.width = W; c.height = H
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#eef1f5'; ctx.fillRect(0, 0, W, H)
  // roll edge guides
  ctx.strokeStyle = '#c8d0da'; ctx.setLineDash([4, 4]); ctx.strokeRect(0.5, 0.5, W - 1, H - 1); ctx.setLineDash([])
  for (const p of n.placements) {
    const d = designs[p.i]
    if (d) ctx.drawImage(d.img, p.x * PPI, p.y * PPI, p.w * PPI, p.h * PPI)
  }
  document.getElementById('gs-sheet-lbl').textContent = n.count ? `${n.count} on sheet · ${Math.ceil(n.usedHeight)}" used` : 'Your sheet preview'
  document.getElementById('gs-price').innerHTML = designs.length
    ? `<span class="gs-price-n">${money(price.subtotal)}</span><span class="gs-price-s">${price.inches}" · ${cfg.dtf.sheetWidth}" roll</span>` : ''
  foot(price)
}

function foot(price) {
  const foot = document.getElementById('gs-foot')
  if (!designs.length) { foot.innerHTML = '<div class="gs-hint">Add designs to build your sheet.</div>'; return }
  foot.innerHTML = `
    <div class="gs-fields">
      <input class="gs-in" id="gs-name" placeholder="Your name">
      <input class="gs-in" id="gs-email" type="email" placeholder="Email for your proof & receipt">
    </div>
    <button class="gs-cta" id="gs-checkout">${cfg.checkout === 'stripe' ? `Check out — ${money(price.subtotal)}` : `Request this sheet — ${money(price.subtotal)}`}</button>
    <div class="gs-secure">${cfg.checkout === 'stripe' ? '🔒 Secure checkout by Stripe' : 'The shop will confirm and send a payment link'}</div>`
  document.getElementById('gs-checkout').onclick = checkout
}

async function checkout() {
  const { items, price } = computed()
  const btn = document.getElementById('gs-checkout'); btn.disabled = true; btn.textContent = 'Working…'
  try {
    const r = await fetch(`/api/embed/gangsheet/order${shopQ}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop: SHOP, name: document.getElementById('gs-name').value, email: document.getElementById('gs-email').value,
        items: items.map((it) => ({ w: it.w, h: it.h, qty: it.qty })), total: price.subtotal }) })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Something went wrong')
    if (d.mode === 'stripe' && d.checkout_url) { location.href = d.checkout_url; return }
    done('quote', d)
  } catch (e) { btn.disabled = false; btn.textContent = 'Try again'; alert(e.message) }
}

function done(kind, d) {
  document.getElementById('gs-root').innerHTML = `<div class="gs"><div class="gs-done">
    <div class="gs-done-ic">✓</div>
    <h2>${kind === 'paid' ? 'Payment received!' : 'Sheet submitted!'}</h2>
    <p>${kind === 'paid' ? 'Your gang sheet is paid and in production. You’ll get a proof by email.'
      : `Thanks! ${esc(cfg.shop)} has your sheet${d?.estimate ? ` (${esc(d.estimate)})` : ''} and will confirm and send a payment link shortly.`}</p>
    <button class="gs-cta" onclick="location.href=location.pathname">Build another sheet</button>
  </div></div>`
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

boot()
