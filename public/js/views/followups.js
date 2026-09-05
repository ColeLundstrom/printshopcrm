import { api, $, esc, money, money0, fmtDate, setPage, empty, toast, go, on, confirmModal } from '../core.js'

/**
 * The money list.
 *
 * This is the answer to "why is the CRM built in?" A shop's biggest leak isn't the press,
 * it's quotes that went quiet and invoices nobody chased. Ranked by dollars, because the
 * $6k quote deserves the call before the $800 one.
 */
export async function followupsView() {
  setPage('Follow-ups')
  $('#view').innerHTML = '<div class="dim">Loading…</div>'
  const d = await api.get('/api/followups')

  const age = (n, unit = 'd') => (n == null ? '—' : `${n}${unit}`)

  // #view survives every render, so delegations live on #fu-body, rebuilt each pass so listeners die with it
  $('#view').innerHTML = `
    <div id="fu-body">
    <div class="kpis">
      <div class="kpi info"><div class="lbl">Quotes waiting</div><div class="val">${money0(d.totals.stale)}</div>
        <div class="sub">${d.stale.length} sent, none approved yet</div></div>
      <div class="kpi bad"><div class="lbl">Overdue money</div><div class="val">${money0(d.totals.overdue)}</div>
        <div class="sub">${d.overdue.length} invoice${d.overdue.length === 1 ? '' : 's'} past due</div></div>
      <div class="kpi warn"><div class="lbl">Proofs with customers</div><div class="val">${d.proofs.length}</div>
        <div class="sub">Blocking production right now</div></div>
      <div class="kpi"><div class="lbl">Gone quiet</div><div class="val">${d.reorder.length}</div>
        <div class="sub">Past customers worth a call</div></div>
    </div>

    <div class="cols">
      <div class="stack">
        <div class="card">
          <div class="card-h"><h3>Quotes that went quiet</h3><div class="spacer"></div>
            <span class="dim" style="font-size:12px">biggest first</span></div>
          ${d.stale.length ? `<table class="tbl">
            <thead><tr><th>Estimate</th><th>Customer</th><th class="num">Value</th><th class="num">Sent</th><th></th></tr></thead>
            <tbody>${d.stale.map((e) => `<tr>
              <td class="click" data-go="/estimates/${e.id}"><span class="mono" style="color:var(--txt)">${esc(e.estimate_number)}</span></td>
              <td><div style="font-weight:600">${esc(e.contact_name || '—')}</div>
                <div class="dim" style="font-size:11.5px">${esc(e.company || e.email || '')}</div></td>
              <td class="num"><strong>${money(e.total)}</strong></td>
              <td class="num"><span style="color:${e.age >= 5 ? 'var(--amber)' : 'var(--txt-2)'}">${age(e.age)}</span></td>
              <td class="num"><button class="btn ghost sm" data-nudge-est="${e.id}" data-recipient-revision="${e.recipient_revision || 0}" data-who="${esc(e.recipient?.email || 'no saved email')}">Nudge</button></td>
            </tr>`).join('')}</tbody></table>`
            : empty('✓', 'No quotes hanging', 'Every estimate you sent has been answered.', '<a class="btn" href="#/estimates">Go to estimates</a>')}
        </div>

        <div class="card">
          <div class="card-h"><h3>Overdue invoices</h3></div>
          ${d.overdue.length ? `<table class="tbl">
            <thead><tr><th>Invoice</th><th>Customer</th><th class="num">Balance</th><th class="num">Late</th><th></th></tr></thead>
            <tbody>${d.overdue.map((i) => `<tr>
              <td class="click" data-go="/invoices/${i.id}"><span class="mono" style="color:var(--txt)">${esc(i.invoice_number)}</span></td>
              <td><div style="font-weight:600">${esc(i.contact_name || '—')}</div>
                <div class="dim" style="font-size:11.5px">due ${fmtDate(i.due_date)}</div></td>
              <td class="num"><strong style="color:var(--amber)">${money(i.balance)}</strong></td>
              <td class="num"><span style="color:var(--red);font-weight:600">${age(i.age)}</span></td>
              <td class="num"><button class="btn ghost sm" data-nudge-inv="${i.id}" data-recipient-revision="${i.recipient_revision || 0}" data-who="${esc(i.recipient?.email || 'no saved email')}">Remind</button></td>
            </tr>`).join('')}</tbody></table>`
            : empty('▣', 'Nothing overdue', 'Everyone has paid on time.', '<a class="btn" href="#/invoices">View invoices</a>')}
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-h"><h3>Proofs sitting with customers</h3></div>
          ${d.proofs.length ? `<table class="tbl"><tbody>${d.proofs.map((a) => `<tr class="click" data-go="/jobs/${a.job_id}">
            <td><div style="font-weight:600;font-size:12.5px">${esc(a.job_title || '')}</div>
              <div class="dim" style="font-size:11.5px">${esc(a.contact_name || '')} · v${a.version}</div></td>
            <td class="num"><span style="color:${a.age >= 2 ? 'var(--red)' : 'var(--txt-2)'};font-size:12px">${age(a.age)} waiting</span>
              <div class="dim" style="font-size:11px">due ${fmtDate(a.due_date)}</div></td>
          </tr>`).join('')}</tbody></table>`
            : '<div class="card-b dim">No proofs pending.</div>'}
        </div>

        <div class="card">
          <div class="card-h"><h3>Worth a call</h3></div>
          ${d.reorder.length ? `<table class="tbl"><tbody>${d.reorder.map((c) => `<tr class="click" data-go="/contacts/${c.id}">
            <td><div style="font-weight:600;font-size:12.5px">${esc(c.name)}</div>
              <div class="dim" style="font-size:11.5px">${esc(c.company || '')} · ${c.jobs} order${c.jobs === 1 ? '' : 's'}</div></td>
            <td class="num"><strong>${money0(c.lifetime)}</strong><div class="dim" style="font-size:11px">${age(c.age)} quiet</div></td>
          </tr>`).join('')}</tbody></table>`
            : '<div class="card-b dim">No lapsed customers.</div>'}
          <div class="card-b" style="border-top:1px solid var(--line)">
            <span class="dim" style="font-size:11.5px">Repeat work is the cheapest revenue in the building. These customers bought before and have gone quiet.</span>
          </div>
        </div>
      </div>
    </div>
    </div>`

  on($('#fu-body'), '[data-go]', (_e, t) => go(t.dataset.go))
  /**
   * Both of these mail a live customer, from a 24px button inside a row that is itself a click
   * target, with no confirm and no undo. And neither awaited the post, so a rejected send — no
   * SMTP, no address, a 429 — became an unhandled rejection while the toast said it had gone.
   * The server now reports `delivered`, so the toast can say which of the two things happened
   * instead of assuming.
   */
  const nudge = (path, title, verb) => async (e, t) => {
    e.stopPropagation()
    const who = t.dataset.who || 'this customer'
    confirmModal(title, `An email goes to ${who} now. There is no way to unsend it.`, async () => {
      t.disabled = true
      try {
        const r = await api.post(path(t),{recipient_revision:Number(t.dataset.recipientRevision)})
        toast(r.delivered === false ? `Drafted to the Outbox — ${verb} are on Manual` : `${verb === 'follow-ups' ? 'Follow-up' : 'Reminder'} sent to ${r.emailed_to || who}`)
        followupsView()
      } catch (err) { toast(err.message, true); t.disabled = false }
    }, 'Send it')
  }
  on($('#fu-body'), '[data-nudge-est]', nudge((t) => `/api/estimates/${t.dataset.nudgeEst}/nudge`, 'Send this follow-up?', 'follow-ups'))
  on($('#fu-body'), '[data-nudge-inv]', nudge((t) => `/api/invoices/${t.dataset.nudgeInv}/nudge`, 'Send this payment reminder?', 'reminders'))
}
