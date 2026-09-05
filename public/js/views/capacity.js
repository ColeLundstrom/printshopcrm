import { api, $, $$, esc, setPage, empty, on, go, fmtDate, today, toast, onOnce, localDay, announce, shopLocale } from '../core.js'

// This page estimates screenprinting presswork. It does not commit a production or shipping date.
let viewRequest = 0
let promiseTimer

const hrs = (m) => `${Math.round((m / 60) * 10) / 10}h`
const dow = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(shopLocale(), { weekday: 'short' })
const dnum = (d) => new Date(`${d}T12:00:00`).getDate()

export async function capacityView() {
  const request = ++viewRequest
  clearTimeout(promiseTimer)
  setPage('Capacity', '', '<span class="dim">Shop</span>')
  $('#view').innerHTML = '<div id="capacity-loading" class="dim" role="status">Reading the press schedule…</div>'
  const loading = $('#capacity-loading')
  try {
    const d = await api.get('/api/capacity')
    if (request !== viewRequest || !loading.isConnected) return
    render(d)
  } catch (error) {
    if (request !== viewRequest || !loading.isConnected) return
    loading.innerHTML = `<p role="alert">${esc(error.message)}</p><button class="btn" id="capacity-retry">Try again</button>`
    $('#capacity-retry').onclick = capacityView
  }
}

function render(d, draft = {}) {
  clearTimeout(promiseTimer)
  const complete = d.scope_complete === true
  const modeled = d.modeled_count ?? 0
  const unresolved = d.unresolved || []
  const cap = d.capacity
  const maxLoad = Math.max(cap.minutes, ...d.timeline.map((t) => t.load), 1)
  const bar = (t) => {
    const h = Math.round((t.load / maxLoad) * 100)
    const full = t.pct >= 100
    const cls = full ? 'full' : t.pct >= 70 ? 'busy' : t.load > 0 ? 'open' : 'free'
    return `<div class="cap-day" title="${fmtDate(t.date)} — ${hrs(t.load)} of ${hrs(t.capacity)} booked (${t.pct}%)">
      <div class="cap-track"><div class="cap-fill ${cls}" style="height:${Math.max(t.load > 0 ? 6 : 0, h)}%"></div>
        <div class="cap-cap" style="bottom:${Math.round((cap.minutes / maxLoad) * 100)}%"></div></div>
      <div class="cap-d">${dow(t.date)}</div><div class="cap-n">${dnum(t.date)}</div>
    </div>`
  }

  $('#view').innerHTML = `
    <div id="capacity-page">
    <p class="dim">Screenprinting presswork only. Dates estimate the last piece off the press; allow separate time for materials, artwork, QC, packing and delivery. Weekdays use ${esc(d.calendar_timezone || 'the server’s local calendar')}, without holidays or downtime.</p>
    ${!complete ? `<div class="card card-b" role="status"><strong>${unresolved.length || d.unresolved_count || 'Some'} active job${unresolved.length === 1 ? '' : 's'} need review</strong><p>The load below is partial. Review excluded methods, quantities or workflow steps before using a print-date estimate.</p></div>` : ''}
    <div class="kpis">
      <div class="kpi ${d.backlogDays >= 5 ? 'warn' : ''}"><div class="lbl">Modeled work through</div>
        <div class="val" style="font-size:20px">${d.bookedThrough ? fmtDate(d.bookedThrough) : '—'}</div>
        <div class="sub">${d.backlogDays} working day${d.backlogDays === 1 ? '' : 's'} queued</div></div>
      <div class="kpi info"><div class="lbl">Unallocated model hours</div><div class="val">${d.freeHoursThisWeek}h</div>
        <div class="sub">${complete ? 'next five working days · presswork only' : 'partial queue · capacity not confirmed'}</div></div>
      <div class="kpi"><div class="lbl">Modeled presswork</div><div class="val">${d.bookedHours}h</div>
        <div class="sub">${modeled} modeled job${modeled === 1 ? '' : 's'}</div></div>
      <div class="kpi ${d.atRiskCount ? 'bad' : ''}"><div class="lbl">Past their production date</div><div class="val">${d.atRiskCount}</div>
        <div class="sub">${d.atRiskCount ? 'modeled jobs only — review dates below' : complete ? 'no modeled date overruns' : 'unresolved work is not included'}</div></div>
    </div>

    <div class="cols" style="align-items:start">
      <div class="stack">
        <div class="card promise">
          <div class="card-h"><h3>Check a screenprint run</h3><div class="spacer"></div>
            <span class="dim" style="font-size:11.5px">Estimated print finish, not a shipping promise</span></div>
          <div class="card-b">
            <div class="promise-grid">
              <label>Pieces<input type="number" id="pq" min="1" value="${esc(draft.pieces || 144)}" inputmode="numeric"></label>
              <label>Colors / screens<input type="number" id="pc" min="1" max="12" value="${esc(draft.colors || 3)}" inputmode="numeric"></label>
              <label>Print by<input type="date" id="pd" value="${esc(draft.due ?? nextFriday())}"></label>
            </div>
            <div id="promise-out" class="promise-out" role="status" aria-live="polite" aria-atomic="true"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><h3>Modeled press load · two weeks</h3><div class="spacer"></div>
            <span class="dim" style="font-size:11.5px">${hrs(cap.minutes)}/day capacity</span></div>
          <div class="card-b"><div class="cap-strip">${d.timeline.map(bar).join('')}</div>
            <div class="cap-legend">
              <span><i class="sw free"></i>Open</span><span><i class="sw open"></i>Booked</span>
              <span><i class="sw busy"></i>Nearly full</span><span><i class="sw full"></i>Solid</span>
              <span class="dim">— capacity line</span>
            </div>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card model">
          <div class="card-h"><h3>Screenprinting model</h3><div class="spacer"></div>
            ${d.can_manage === true ? '<button class="btn ghost sm" id="model-toggle" aria-controls="model-edit" aria-expanded="false">Adjust</button>' : ''}</div>
          <div class="card-b">
            <div class="model-formula">
              <b>${cap.stations}</b> press${cap.stations === 1 ? '' : 'es'} ×
              <b>${cap.hours}h</b> ×
              <b>${cap.utilizationPct}%</b> real print time =
              <strong style="color:var(--accent)">${hrs(cap.minutes)}/day</strong>
            </div>
            <p class="dim" style="font-size:11.5px;margin-top:8px;line-height:1.55">Set these assumptions from your shop’s measured throughput. One job uses at most one press at a time; separate jobs can use parallel presses. This model does not measure live machine or employee availability.</p>
            ${d.can_manage === true ? `<div id="model-edit" hidden>
              <div class="model-grid">
                <label>Presses / stations<input type="number" id="ms" min="1" max="20" value="${cap.stations}"></label>
                <label>Working hours / day<input type="number" id="mh" min="1" max="24" step="0.5" value="${cap.hours}"></label>
                <label>Real print time %<input type="number" id="mu" min="5" max="100" value="${cap.utilizationPct}"></label>
              </div>
              <button class="btn sm" id="model-save" style="margin-top:10px">Save & recompute</button>
              <div id="model-error" role="alert"></div>
            </div>` : '<p class="dim">An owner or manager can adjust these assumptions.</p>'}
          </div>
        </div>

        ${unresolved.length ? `<div class="card"><div class="card-h"><h3>Needs a manual review</h3></div><div class="card-b"><ul>${unresolved.map(job => `<li><a href="#/jobs/${encodeURIComponent(job.id)}">${esc(job.job_number || job.title || 'Job')}</a>: ${esc(job.reason)}</li>`).join('')}</ul></div></div>` : ''}
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-h"><h3>Active jobs and model coverage</h3><div class="spacer"></div>
        <a class="btn ghost sm" href="#/board">Open board</a></div>
      ${d.jobs.length ? `<table class="tbl stack">
        <thead><tr><th>Job</th><th class="num">Press time</th><th>Production due</th><th>Estimated print finish</th><th class="num">Status</th></tr></thead>
        <tbody>${[...d.jobs].sort(byDue).map(jobRow).join('')}</tbody></table>
        <div class="card-b" style="border-top:1px solid var(--line);font-size:11.5px">
          <span class="dim">Sooner-due modeled jobs claim the press first. Finishing or skipping production removes its load; QC and shipping do not reserve the press again. Custom workflows with unresolved production steps require manual review. The calendar remains your independent plan.</span></div>`
        : empty('▦', 'No active jobs', 'Jobs with known screenprinting work appear in this model.')}
    </div></div>`

  wire(d)
}

const byDue = (a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0

function jobRow(j) {
  const late = j.daysLate > 0
  const unresolved = j.scope_state === 'unresolved'
  const finished = j.scope_state === 'finished'
  const status = unresolved ? '<span class="pill amber">needs review</span>'
    : finished ? '<span class="pill gray">presswork finished</span>'
      : late ? `<span class="pill red">${j.daysLate}d past due</span>` : '<span class="pill gray">modeled</span>'
  return `<tr class="click" data-job="${j.id}">
    <td data-label="Job"><div style="font-weight:600">${esc(j.title || 'Untitled')}</div>
      <div class="mono">${esc(j.job_number || '')}${j.rush ? ' · <span style="color:var(--red)">RUSH</span>' : ''}${j.contact_name ? ' · ' + esc(j.contact_name) : ''}</div></td>
    <td data-label="Press time" class="num">${unresolved || finished ? '<span class="dim">—</span>' : hrs(j.minutes)}</td>
    <td data-label="Production due">${j.due ? fmtDate(j.due) : '<span class="dim">—</span>'}</td>
    <td data-label="Estimated print finish">${j.projectedFinish ? `<strong style="color:${late ? 'var(--amber)' : 'var(--txt)'}">${fmtDate(j.projectedFinish)}</strong>` : '<span class="dim">—</span>'}</td>
    <td data-label="Model status" class="num">${status}${j.reason ? `<div class="dim" style="font-size:11.5px;margin-top:4px">${esc(j.reason)}</div>` : ''}</td>
  </tr>`
}

function wire(d) {
  onOnce($('#view'), '[data-job]', (_e, el) => go(`/jobs/${el.dataset.job}`))
  const page = $('#capacity-page')
  const out = $('#promise-out')
  const quantity = $('#pq'), colorCount = $('#pc'), wanted = $('#pd')
  let request = 0, saving = false
  const active = () => page.isConnected
  const runPromise = () => {
    if (!active()) return
    const current = ++request
    const pieces = Number(quantity.value) || 0
    const colors = Number(colorCount.value) || 1
    const due = wanted.value || ''
    if (pieces <= 0) { out.innerHTML = '<div class="dim" style="font-size:12.5px">Enter a piece count.</div>'; return }
    out.innerHTML = '<div class="dim">Checking the screenprinting model…</div>'
    api.post('/api/capacity/promise', { pieces, colors, due_date: due, decoration: 'Screen Print' }).then((r) => {
      if (!active() || current !== request) return
      if (!r.earliestFinish) {
        const why = r.reason || 'The scheduler could not place this run.'
        const head = r.beyondHorizon ? 'Not schedulable' : 'Cannot check yet'
        out.innerHTML = `<div class="promise-verdict no"><div class="pv-main">${esc(head)}</div><div class="pv-note">${esc(why)}</div></div>`
        announce(`${head}. ${why}`)
        return
      }
      if (r.scope_complete !== true || r.feasible === null) {
        out.innerHTML = '<div class="dim">Capacity coverage is incomplete. Refresh and review the active jobs before estimating a print date.</div>'
        return
      }
      const finishStr = fmtDate(r.earliestFinish)
      const cushion = Number(r.slackDays) || 0
      let verdict, cls, note
      if (!due) { verdict = `Estimated print finish: ${finishStr}`; cls = 'ok'; note = `${r.hours}h of press time · ${r.workingDaysOut} working day${r.workingDaysOut === 1 ? '' : 's'} out` }
      else if (r.feasible) { verdict = `Print model fits by ${finishStr}`; cls = 'ok'; note = cushion > 0 ? `${cushion} working day${cushion === 1 ? '' : 's'} before ${fmtDate(due)}` : `lands on ${fmtDate(due)} — no model slack` }
      else { verdict = `Print model exceeds ${fmtDate(due)}`; cls = 'no'; note = `estimated print finish is ${finishStr} — ${Math.abs(cushion)} working day${Math.abs(cushion) === 1 ? '' : 's'} after the requested date. Review the production plan.` }
      note += ' Allow separate time for prerequisites, QC and delivery.'
      out.innerHTML = `<div class="promise-verdict ${cls}"><div class="pv-main">${esc(verdict)}</div><div class="pv-note">${esc(note)}</div></div>`
      announce(`${verdict}. ${note}`)
    }).catch((e) => { if (active() && current === request) out.innerHTML = `<div class="dim">${esc(e.message)}</div>` })
  }
  ;['#pq', '#pc', '#pd'].forEach((sel) => on($(sel).closest('.promise-grid'), sel, () => {
    ++request // Invalidate on input, before the debounce can start a replacement request.
    clearTimeout(promiseTimer)
    if (!active()) return
    out.innerHTML = '<div class="dim">Waiting for your changes…</div>'
    promiseTimer = setTimeout(runPromise, 250)
  }, 'input'))
  runPromise()

  const toggle = $('#model-toggle'), save = $('#model-save')
  if (toggle) toggle.onclick = () => { if (!active()) return; const edit = $('#model-edit'); edit.hidden = !edit.hidden; toggle.setAttribute('aria-expanded', String(!edit.hidden)) }
  if (save) save.onclick = async () => {
    if (!active() || saving) return
    const inputs = [$('#ms'), $('#mh'), $('#mu')]
    if (inputs.some(input => input.reportValidity && !input.reportValidity())) return
    const body = { capacity_stations: inputs[0].value, capacity_hours_per_day: inputs[1].value, utilization_pct: inputs[2].value }
    const error = $('#model-error')
    saving = true; save.disabled = true; save.textContent = 'Saving…'; error.textContent = ''
    inputs.forEach(input => { input.disabled = true })
    try {
      const result = await api.put('/api/capacity/settings', body)
      if (!active()) return
      render(result, { pieces: quantity.value, colors: colorCount.value, due: wanted.value }); toast('Capacity updated')
      $('#model-toggle')?.focus()
    } catch (e) { if (active()) error.textContent = e.message }
    finally { saving = false; if (active()) { save.disabled = false; save.textContent = 'Save & recompute'; inputs.forEach(input => { input.disabled = false }) } }
  }
}

/** A sensible default target for the promise tool — the coming Friday. */
function nextFriday() {
  const d = new Date(`${today()}T12:00:00`)
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7))
  return localDay(d)
}
