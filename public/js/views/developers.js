import { api, $, esc, setPage, on, toast, modal, closeModal, formData, fmtDate , onOnce} from '../core.js'

/**
 * Developers — API key, webhook subscriptions, delivery log, docs. On every plan: the
 * incumbents all gate this behind their top tier, and it costs them named customers.
 */

export async function developersView() {
  setPage('Developers', '', '<span class="dim">More</span>')
  $('#view').innerHTML = '<div class="dim">Loading…</div>'
  paint(await api.get('/api/developers'))

  // Bind ONCE, and delegate on #view — which is shared by every screen and never replaced. These
  // handlers used to be re-attached on every render, and each webhook toggle/delete re-entered the
  // view, so "Rotate key" fired two, three, seven times and raced itself into showing a dead key.
  // A re-fetch after an action now just repaints; the listeners stay put.
  const refresh = async () => { try { paint(await api.get('/api/developers')) } catch (e) { toast(e.message, true) } }

  onOnce($('#view'), '#dev-rotate', async () => {
    try {
      const r = await api.post('/api/developers/key/rotate')
      $('#dev-key-full').innerHTML = `<div class="dev-secret">Your new key — copy it now, it won't be shown again:<br><code>${esc(r.api_key)}</code></div>`
      $('#dev-key').textContent = `${r.api_key.slice(0, 13)}…${r.api_key.slice(-4)}`
      toast('New API key created')
    } catch (e) { toast(e.message, true) }
  })
  onOnce($('#view'), '#dev-revoke', async () => {
    try { await api.post('/api/developers/key/revoke'); toast('API key revoked'); refresh() }
    catch (e) { toast(e.message, true) }
  })
  onOnce($('#view'), '#dev-add-wh', () => {
    modal({
      title: 'Add webhook',
      body: `<label>URL<input name="url" placeholder="https://hooks.zapier.com/…" required /></label>
             <label>Events <span class="dim">(comma list, or * for everything)</span><input name="events" value="*" /></label>`,
      footer: '<button class="btn primary" id="wh-save">Add</button>',
      onMount: (bg) => {
        on(bg, '#wh-save', async () => {
          try {
            const r = await api.post('/api/developers/webhooks', formData(bg))
            closeModal()
            toast('Webhook added')
            modal({
              title: 'Signing secret',
              body: `<p class="dim">Copy this now — it is shown once. Verify deliveries by recomputing the HMAC in <code>X-PSC-Signature</code>.</p><code class="dev-secret">${esc(r.secret)}</code>`,
              footer: '<button class="btn" onclick="document.querySelector(\'.modal-bg\')?.remove()">Done</button>',
            })
            refresh()
          } catch (e) { toast(e.message, true) }
        })
      },
    })
  })
  onOnce($('#view'), '[data-wh-toggle]', async (e) => {
    const b = e.target.closest('[data-wh-toggle]')
    try { await api.patch(`/api/developers/webhooks/${b.dataset.whToggle}`, { active: b.dataset.active !== '1' }); refresh() }
    catch (err) { toast(err.message, true) }
  })
  onOnce($('#view'), '[data-wh-del]', async (e) => {
    const b = e.target.closest('[data-wh-del]')
    try { await api.del(`/api/developers/webhooks/${b.dataset.whDel}`); refresh() }
    catch (err) { toast(err.message, true) }
  })
  // Three attempts over about ten minutes is the whole retry budget, so an endpoint that was down
  // over lunch drops every event in that window and the row goes to 'failed', which the retry loop
  // never looks at again. The payload is still on it — this hands the delivery back to the durable
  // pipeline with a fresh budget. Without the button the log was red and there was nothing to press.
  onOnce($('#view'), '[data-wh-redeliver]', async (e) => {
    const b = e.target.closest('[data-wh-redeliver]')
    b.disabled = true
    try { await api.post(`/api/developers/deliveries/${b.dataset.whRedeliver}/redeliver`, {}); toast('Sending again…') }
    catch (err) { toast(err.message, true) }
    refresh()
  })
}

function paint(d) {
  $('#view').innerHTML = `
    <div class="card">
      <h2>API key</h2>
      <p class="dim">Full REST access to customers, estimates, invoices, jobs and payments — every plan, 120 requests/min. <a href="${esc(d.docs)}" target="_blank">Read the docs →</a></p>
      <div class="dev-key-row">
        <code id="dev-key">${d.api_key_set ? esc(d.api_key_preview) : 'No key yet'}</code>
        <button class="btn" id="dev-rotate">${d.api_key_set ? 'Rotate key' : 'Create key'}</button>
        ${d.api_key_set ? '<button class="btn ghost" id="dev-revoke">Revoke</button>' : ''}
      </div>
      <div id="dev-key-full"></div>
    </div>

    <div class="card">
      <h2>Webhooks</h2>
      <p class="dim">POSTs to your URL on shop events, signed with a per-endpoint secret (<code>X-PSC-Signature</code>). Point one at Zapier, Make, or your own server.</p>
      <div class="dev-events dim" style="font-size:11.5px;margin-bottom:8px">Events: ${d.events.map((e) => `<code>${esc(e)}</code>`).join(' ')}</div>
      ${d.webhooks.length ? `<table class="tbl">
        <tr><th>URL</th><th>Events</th><th>Active</th><th></th></tr>
        ${d.webhooks.map((w) => `<tr>
          <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(w.url)}</td>
          <td><code style="font-size:11px">${esc(w.events)}</code></td>
          <td><button class="btn ghost sm" data-wh-toggle="${w.id}" data-active="${w.active}">${w.active ? 'On' : 'Off'}</button></td>
          <td class="r"><button class="btn ghost sm" data-wh-del="${w.id}">Delete</button></td>
        </tr>`).join('')}
      </table>` : ''}
      <button class="btn" id="dev-add-wh" style="margin-top:8px">Add webhook</button>
    </div>

    ${d.deliveries.length ? `<div class="card">
      <h2>Recent deliveries${d.failed_deliveries ? ` <span class="pill red">${d.failed_deliveries} failed</span>` : ''}</h2>
      <table class="tbl">
        <tr><th>Event</th><th>URL</th><th>Status</th><th>Detail</th><th>When</th><th></th></tr>
        ${d.deliveries.map((r) => `<tr>
          <td><code style="font-size:11px">${esc(r.event)}</code></td>
          <td class="dim" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;font-size:11.5px">${esc(r.url)}</td>
          <td><span class="pill ${r.status === 'delivered' ? 'green' : r.status === 'failed' ? 'red' : 'amber'}">${esc(r.status)}</span></td>
          <td class="dim" style="font-size:11px">${esc(r.last_error || '')}</td>
          <td class="dim" style="font-size:11px">${fmtDate(r.created_at)}</td>
          <td class="r">${r.status === 'failed' ? `<button class="btn ghost sm" data-wh-redeliver="${r.id}">Send again</button>` : ''}</td>
        </tr>`).join('')}
      </table>
    </div>` : ''}`
}
