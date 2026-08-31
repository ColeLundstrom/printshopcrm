import { api, $, esc, setPage, on, toast } from '../core.js'

/**
 * Billing — one plan, everything included. Shows trial status, the single plan (monthly/annual),
 * and Manage-subscription for paying shops. The platform owner also gets a card to connect the
 * company's own Stripe so charges actually collect.
 *
 * There is deliberately nothing to compare here: every shop runs the same software with every
 * feature (2026-08-21). The page exists to take payment, not to upsell.
 */
export async function billingView() {
  setPage('Billing')
  const [d, me] = await Promise.all([api.get('/api/billing'), api.get('/api/auth/me').catch(() => ({}))])
  const st = d.state || {}
  const plans = d.plans || {}
  const order = (d.order && d.order.length ? d.order : ['everything']).filter((k) => plans[k])
  let interval = 'month'

  const banner = () => {
    if (st.subscribed) return `<div class="bill-status ok">✓ You're on the <strong>${esc((plans[st.plan] || {}).name || st.plan || 'active')}</strong> plan. Thanks for being a customer.</div>`
    if (st.status === 'trial_expired' || st.locked) return `<div class="bill-status warn">Your free trial has ended. Choose a plan below to keep creating work — your data is safe and waiting.</div>`
    return `<div class="bill-status">You're on a free trial — <strong>${st.trial_days_left} day${st.trial_days_left === 1 ? '' : 's'} left</strong>. Pick a plan any time; no card needed until you do.</div>`
  }

  const planCard = (key) => {
    const p = plans[key]
    if (!p) return ''
    // The Free plan has no monthly price to prorate, so the annual toggle and the "save with annual"
    // line don't apply to it — showing "$0/yr — 2 months free" would read as a bug.
    const isFree = !p.monthly
    const price = isFree ? 0 : (interval === 'year' ? Math.round(p.annual / 12) : p.monthly)
    const isCurrent = st.subscribed && st.plan === key
    return `<div class="plan ${p.popular ? 'pop' : ''} ${isCurrent ? 'cur' : ''}">
      ${p.popular ? '<div class="plan-badge">Everything included</div>' : ''}
      <div class="plan-name">${esc(p.name)}</div>
      <div class="plan-tag">${esc(p.tagline)}</div>
      <div class="plan-price"><span class="amt">$${price}</span><span class="per">/mo</span></div>
      ${isFree ? '<div class="plan-annual">no monthly fee — 4% per payment collected</div>'
        : interval === 'year' ? `<div class="plan-annual">billed $${p.annual}/yr — 2 months free</div>` : '<div class="plan-annual">or save with annual</div>'}
      <ul class="plan-feats">${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      ${isCurrent ? '<button class="btn ghost" disabled>Current plan</button>'
        : `<button class="btn ${p.popular ? '' : 'ghost'}" data-plan="${key}">${isFree ? 'Start on Free' : (st.subscribed ? 'Switch to ' + esc(p.name) : 'Choose ' + esc(p.name))}</button>`}
    </div>`
  }

  const adminCard = me.is_admin ? `<div class="card" style="margin-top:22px">
      <div class="card-h"><h3>Platform billing (owner)</h3><span class="pill ${d.live ? 'green' : ''}">${d.live ? 'Stripe connected — collecting' : 'not connected'}</span></div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:12px">Connect <strong style="color:var(--txt-2)">your company's</strong> Stripe so shop subscriptions actually charge. Your secret key is stored server-side and never shown again. Then add the webhook <code>${location.origin}/webhooks/stripe</code> in Stripe and paste its signing secret.</p>
        <div class="field"><label>Platform Stripe secret key</label><input class="input" id="pk-secret" type="password" placeholder="sk_live_… (stored, never displayed)"></div>
        <div class="field"><label>Webhook signing secret</label><input class="input" id="pk-webhook" type="password" placeholder="whsec_…"></div>
        <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn" id="pk-save">Save & go live</button></div>
      </div>
    </div>` : ''

  $('#view').innerHTML = `<div class="bill">
    ${banner()}
    <div class="bill-toggle">
      <button type="button" class="${interval === 'month' ? 'on' : ''}" data-int="month" aria-pressed="${interval === 'month'}">Monthly</button>
      <button type="button" class="${interval === 'year' ? 'on' : ''}" data-int="year" aria-pressed="${interval === 'year'}">Annual · 2 months free</button>
    </div>
    <div class="plans">${order.map(planCard).join('')}</div>
    ${st.subscribed && st.stripe_customer_id ? '<div class="row" style="justify-content:center;margin-top:18px"><button class="btn ghost" id="manage">Manage or cancel subscription →</button></div>' : ''}
    ${!d.live ? '<div class="dim" style="text-align:center;margin-top:16px;font-size:12.5px">Checkout goes live once the platform Stripe is connected.</div>' : ''}
    ${adminCard}
  </div>`

  const rerender = () => billingView()

  // Bound to the containers this render just created, never to the persistent #view — a #view
  // binding survives every revisit, so one plan click would open a Checkout Session per visit.
  on($('.bill-toggle', $('#view')), '[data-int]', (_e, t) => { interval = t.dataset.int; paintPlans() })
  function paintPlans() {
    $('.bill-toggle', $('#view')).querySelectorAll('button').forEach((b) => { const on = b.dataset.int === interval; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)) })
    $('.plans', $('#view')).innerHTML = order.map(planCard).join('')
  }

  let starting = false
  on($('.plans', $('#view')), '[data-plan]', async (_e, t) => {
    if (starting) return
    starting = true
    const btn = t; const key = btn.dataset.plan
    btn.disabled = true; btn.textContent = 'Starting…'
    try {
      // Free has nothing to charge, so it activates server-side instead of opening Stripe Checkout.
      if (!plans[key]?.monthly) {
        await api.post('/api/billing/free', {})
        toast("You're on the Free plan — invoice away.")
        starting = false; rerender(); return
      }
      const r = await api.post('/api/billing/checkout', { plan: key, interval })
      if (r.url) { location.href = r.url; return }
      toast('Could not start checkout', true); btn.disabled = false; starting = false
    } catch (e) { toast(e.message, true); btn.disabled = false; starting = false; rerender() }
  })

  // Guard must match the render condition above — a Free shop is `subscribed` but has no Stripe
  // customer and therefore no button, so binding on subscribed alone would throw on null.
  if (st.subscribed && st.stripe_customer_id) $('#manage').onclick = async () => {
    try { const r = await api.post('/api/billing/portal'); if (r.url) location.href = r.url } catch (e) { toast(e.message, true) }
  }

  if (me.is_admin) $('#pk-save').onclick = async () => {
    const secret = $('#pk-secret').value.trim()
    const webhook_secret = $('#pk-webhook').value.trim()
    if (!secret && !webhook_secret) { toast('Paste your platform secret key'); return }
    try {
      const r = await api.post('/api/admin/billing', { platform_secret: secret, webhook_secret })
      toast(r.live ? 'Stripe connected — billing is live' : 'Saved')
      rerender()
    } catch (e) { toast(e.message, true) }
  }
}
