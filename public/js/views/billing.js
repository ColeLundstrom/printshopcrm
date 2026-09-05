import { api, $, esc, setPage, on, toast } from '../core.js'

// The software is free. This screen manages optional server hosting and basic setup.
export async function billingView() {
  setPage('Hosting')
  const [d, me] = await Promise.all([api.get('/api/billing'), api.get('/api/auth/me').catch(() => ({}))])
  const st = d.state || {}
  const plans = d.plans || {}
  const manageExisting = d.has_subscription && !['canceled','incomplete_expired'].includes(st.status)
  const canManage = d.can_manage !== false
  const checkout = d.hosting_checkout || {}
  const intent = checkout.intent
  const pending = intent && !['complete','expired','closed'].includes(intent.state)
  const needsVerification = !!checkout.pending_verifications?.length
  const needsReview = !!checkout.anomalies?.length || needsVerification
  const order = (d.order && d.order.length ? d.order : ['everything']).filter((k) => plans[k])
  let interval = intent?.interval === 'year' ? 'year' : 'month'

  const banner = () => {
    if (!d.live) return '<div class="bill-status ok"><strong>Free and open source.</strong> Every feature is available, with unlimited users and no software subscription.</div>'
    if (st.subscribed) return `<div class="bill-status ok">✓ You're on the <strong>${esc((plans[st.plan] || {}).name || st.plan || 'active')}</strong> plan. Thanks for being a customer.</div>`
    if (['canceled','incomplete_expired'].includes(st.status)) return '<div class="bill-status">Your previous hosting subscription has ended. You can manage its billing history below or start hosting again.</div>'
    if (st.status === 'trial_expired' || st.locked) return `<div class="bill-status warn">Your hosting trial has ended. Choose managed hosting below to continue on this server. The software remains free to self-host, and your data can be exported.</div>`
    return `<div class="bill-status">You're on a hosting trial — <strong>${st.trial_days_left} day${st.trial_days_left === 1 ? '' : 's'} left</strong>. Pick a plan any time; no card needed until you do.</div>`
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
        : !canManage ? '<p class="dim">Your shop owner manages hosting.</p>'
        : pending || needsReview ? `<button class="btn ghost" disabled>${needsReview ? 'Resolve the payment review first' : 'Resolve the saved checkout first'}</button>`
        : manageExisting ? '<button class="btn ghost" disabled>Use Manage hosting below</button>'
        : `<button class="btn ${p.popular ? '' : 'ghost'}" data-plan="${key}">${isFree ? 'Start on Free' : (st.subscribed ? 'Switch to ' + esc(p.name) : 'Choose ' + esc(p.name))}</button>`}
    </div>`
  }

  const checkoutCard = () => {
    if (!canManage || (!pending && !needsReview)) return ''
    const messages = {
      reserved: 'Your checkout is saved. Continue to open the same payment page.',
      creating: 'Your checkout is being opened. Check its status in a moment.',
      unknown: 'Stripe has not confirmed the checkout result. Check its status before making another payment.',
      open: 'This payment page is already open. Continue with it, or close it before choosing different billing terms.',
      held: 'This checkout needs review before another payment can begin. Check its status or contact the server operator.',
    }
    return `<section class="card hosting-recovery" aria-labelledby="hosting-recovery-title">
      <div class="card-h"><h3 id="hosting-recovery-title">${needsReview ? 'Hosting payment needs review' : 'Continue your hosting checkout'}</h3></div>
      <div class="card-b">
        <p>${esc(messages[intent?.state] || 'A hosting payment needs to be checked by the server operator before another checkout can begin.')}</p>
        ${intent ? `<p class="dim">${esc(plans[intent.plan]?.name || 'Managed hosting')} · ${intent.interval === 'year' ? 'Annual' : 'Monthly'}</p>` : ''}
        ${needsReview ? `<p>${needsVerification ? 'A received hosting payment is awaiting verification.' : 'A payment could not be matched safely to this shop.'} Contact the server operator before paying again.</p>` : ''}
        <div class="row hosting-recovery-actions">
          ${d.live && intent?.can_retry && !needsReview ? '<button type="button" class="btn" id="hosting-resume">Continue checkout</button>' : ''}
          ${d.live ? needsVerification ? '<button type="button" class="btn ghost" id="hosting-refresh">Refresh hosting status</button>' : '<button type="button" class="btn ghost" id="hosting-check">Check payment status</button>' : '<p>Ask the server operator to reconnect hosting billing to check this payment.</p>'}
          ${d.live && intent?.can_expire && !needsReview ? '<button type="button" class="btn ghost" id="hosting-expire">Close unpaid checkout</button>' : ''}
        </div>
        ${d.live && pending ? `<details class="hosting-recovery-details"><summary>Recover a checkout with its Stripe ID</summary>
          <p class="dim">If the server operator found this checkout in Stripe, enter its Checkout Session ID. The payment and shop details will be verified before it is used.</p>
          <div class="field"><label for="hosting-session-id">Checkout Session ID</label><input id="hosting-session-id" class="input" type="text" maxlength="203" placeholder="cs_…" autocomplete="off" spellcheck="false"></div>
          <button type="button" class="btn ghost" id="hosting-recover">Verify checkout</button>
        </details>` : ''}
      </div>
    </section>`
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
    ${checkoutCard()}
    ${d.live ? `<div class="bill-toggle">
      <button type="button" class="${interval === 'month' ? 'on' : ''}" data-int="month" aria-pressed="${interval === 'month'}">Monthly</button>
      <button type="button" class="${interval === 'year' ? 'on' : ''}" data-int="year" aria-pressed="${interval === 'year'}">Annual · 2 months free</button>
    </div>
    <div class="plans">${order.map(planCard).join('')}</div>` : `<div class="card"><div class="card-b">
      <h3>Run it yourself, or let us host it</h3>
      <p>The community builds the same software for everyone. Optional paid hosting covers running it on our server and basic shop setup.</p>
      <p>You keep your data and can move to your own server. There are no paid feature tiers.</p>
      <a class="btn ghost" href="https://github.com/ColeLundstrom/printshopcrm" target="_blank" rel="noopener noreferrer">Source code and community</a>
    </div></div>`}
    ${d.live && canManage && st.stripe_customer_id ? '<div class="row" style="justify-content:center;margin-top:18px"><button class="btn ghost" id="manage">Manage hosting</button></div>' : ''}
    ${d.live ? '<p class="dim">Payment covers managed hosting and basic setup. The same software is free to self-host.</p>' : ''}
    <p class="dim">Want to help maintain the free software? <a href="#/support">Support the project</a>. Contributions are optional and separate from hosting.</p>
    ${adminCard}
  </div>`

  const rerender = () => billingView()
  const refreshHosting = $('#hosting-refresh')
  if(refreshHosting) refreshHosting.onclick=async()=>{refreshHosting.disabled=true;try{await rerender()}catch(error){toast(error.message,true);refreshHosting.disabled=false}}

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
      toast('Checkout saved. Review its payment status below.'); starting = false; await rerender()
    } catch (e) { toast(e.message, true); btn.disabled = false; starting = false; rerender() }
  })

  // Guard must match the render condition, including canceled hosting and owner access.
  if (d.live && canManage && st.stripe_customer_id) $('#manage').onclick = async () => {
    try { const r = await api.post('/api/billing/portal'); if (r.url) location.href = r.url } catch (e) { toast(e.message, true) }
  }

  let recovering = false
  const recoveryAction = (selector,path,body,openCheckout=false) => {
    const button=$(selector)
    if(!button) return
    button.onclick=async () => {
      if(recovering) return
      const payload=body()
      if(payload == null) return
      recovering=true;button.disabled=true
      try {
        const result=await api.post(path,payload)
        if(openCheckout && result.url) { location.href=result.url;return }
        toast(result.intent?.state === 'complete' ? 'Hosting payment confirmed.' : result.intent?.state === 'expired' ? 'Unpaid checkout closed.' : 'Payment status checked. Review the details below.')
      } catch(error) { toast(error.message,true) }
      finally { recovering=false;await rerender() }
    }
  }
  if(canManage && d.live && (pending || needsReview)) {
    recoveryAction('#hosting-resume','/api/billing/checkout',()=>({plan:intent.plan,interval:intent.interval}),true)
    recoveryAction('#hosting-check','/api/billing/checkout/reconcile',()=>({}))
    recoveryAction('#hosting-expire','/api/billing/checkout/expire',()=>({}))
    recoveryAction('#hosting-recover','/api/billing/checkout/reconcile',()=>{
      const id=$('#hosting-session-id').value.trim()
      if(!/^cs_[A-Za-z0-9_]{1,200}$/.test(id)) { toast('Enter the Checkout Session ID from Stripe.',true);return null }
      return {session_id:id}
    })
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
