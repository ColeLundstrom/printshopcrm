import { api, $, $$, esc, setPage, empty, on, go, fmtDate, today, toast , onOnce} from '../core.js'

/**
 * Capacity & Promise Dates — the question no MIS answers: can the shop physically hit this date
 * given everything already on the press? Same press-time tables as the costing engine, so the
 * schedule and the quote never disagree. The promise tool is the star: type a job, get a real,
 * board-aware ship date before anyone promises the customer anything.
 */

let promiseTimer

const hrs = (m) => `${Math.round((m / 60) * 10) / 10}h`
const dow = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' })
const dnum = (d) => new Date(`${d}T12:00:00`).getDate()

export async function capacityView() {
  setPage('Capacity', '', '<span class="dim">Shop</span>')
  $('#view').innerHTML = '<div class="dim">Reading the press schedule…</div>'
  const d = await api.get('/api/capacity')
  render(d)
}

function render(d) {
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

  const bookedThrough = d.bookedThrough
    ? `${fmtDate(d.bookedThrough)} <span class="dim">· ${d.backlogDays} working day${d.backlogDays === 1 ? '' : 's'} of work queued</span>`
    : 'Press is open — nothing queued'

  $('#view').innerHTML = `
    <div class="kpis">
      <div class="kpi ${d.backlogDays >= 5 ? 'warn' : ''}"><div class="lbl">Booked solid through</div>
        <div class="val" style="font-size:20px">${d.bookedThrough ? fmtDate(d.bookedThrough) : '—'}</div>
        <div class="sub">${d.backlogDays} working day${d.backlogDays === 1 ? '' : 's'} queued</div></div>
      <div class="kpi info"><div class="lbl">Free press-hours this week</div><div class="val">${d.freeHoursThisWeek}h</div>
        <div class="sub">room to take on new work</div></div>
      <div class="kpi"><div class="lbl">Booked on the floor</div><div class="val">${d.bookedHours}h</div>
        <div class="sub">${d.jobs.length} active job${d.jobs.length === 1 ? '' : 's'}</div></div>
      <div class="kpi ${d.atRiskCount ? 'bad' : ''}"><div class="lbl">Can't hit their date</div><div class="val">${d.atRiskCount}</div>
        <div class="sub">${d.atRiskCount ? 'over capacity — see below' : 'schedule is realistic'}</div></div>
    </div>

    <div class="cols" style="align-items:start">
      <div class="stack">
        <div class="card promise">
          <div class="card-h"><h3>Can we promise this date?</h3><div class="spacer"></div>
            <span class="dim" style="font-size:11.5px">Checks against everything on the press now</span></div>
          <div class="card-b">
            <div class="promise-grid">
              <label>Pieces<input type="number" id="pq" min="1" value="144" inputmode="numeric"></label>
              <label>Colors / screens<input type="number" id="pc" min="1" max="12" value="3" inputmode="numeric"></label>
              <label>Wanted by<input type="date" id="pd" value="${nextFriday()}"></label>
            </div>
            <div id="promise-out" class="promise-out"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><h3>Next two weeks on the press</h3><div class="spacer"></div>
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
          <div class="card-h"><h3>Your capacity</h3><div class="spacer"></div>
            <button class="btn ghost sm" id="model-toggle">Adjust</button></div>
          <div class="card-b">
            <div class="model-formula">
              <b>${cap.stations}</b> press${cap.stations === 1 ? '' : 'es'} ×
              <b>${cap.hours}h</b> ×
              <b>${cap.utilizationPct}%</b> real print time =
              <strong style="color:var(--accent)">${hrs(cap.minutes)}/day</strong>
            </div>
            <p class="dim" style="font-size:11.5px;margin-top:8px;line-height:1.55">Presses image only ~24–33% of the paid clock — setup, breaks, approvals, packing eat the rest. Costing this shop uses the same number, so your schedule and your prices agree.</p>
            <div id="model-edit" hidden>
              <div class="model-grid">
                <label>Presses / stations<input type="number" id="ms" min="1" max="20" value="${cap.stations}"></label>
                <label>Working hours / day<input type="number" id="mh" min="1" max="24" step="0.5" value="${cap.hours}"></label>
                <label>Real print time %<input type="number" id="mu" min="5" max="100" value="${cap.utilizationPct}"></label>
              </div>
              <button class="btn sm" id="model-save" style="margin-top:10px">Save & recompute</button>
            </div>
          </div>
        </div>

        ${d.unsized.length ? `<div class="card" style="border-color:rgba(247,185,85,.35)">
          <div class="card-b" style="font-size:12.5px"><strong style="color:var(--amber)">${d.unsized.length} job${d.unsized.length === 1 ? '' : 's'} without a size count</strong> aren't in the schedule yet — add quantities so they claim their press time.</div></div>` : ''}
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-h"><h3>The board, scheduled</h3><div class="spacer"></div>
        <a class="btn ghost sm" href="#/board">Open board</a></div>
      ${d.jobs.length ? `<table class="tbl">
        <thead><tr><th>Job</th><th class="num">Press time</th><th>Due</th><th>Realistically ships</th><th class="num">Status</th></tr></thead>
        <tbody>${[...d.jobs].sort(byDue).map(jobRow).join('')}</tbody></table>
        <div class="card-b" style="border-top:1px solid var(--line);font-size:11.5px" class="dim">
          <span class="dim">Sooner-due jobs claim the press first. "Realistically ships" is when each job's last piece comes off given everything ahead of it — not the date typed at intake.</span></div>`
        : empty('▦', 'Nothing on the press', 'Approve an estimate to put a job on the schedule.')}
    </div>`

  wire(d)
}

const byDue = (a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0

function jobRow(j) {
  const late = j.daysLate > 0
  const status = j.unsized
    ? '<span class="pill gray">no size</span>'
    : late ? `<span class="pill red">${j.daysLate}d late</span>` : '<span class="pill green">on time</span>'
  return `<tr class="click" data-job="${j.id}">
    <td><div style="font-weight:600">${esc(j.title || 'Untitled')}</div>
      <div class="mono">${esc(j.job_number || '')}${j.rush ? ' · <span style="color:var(--red)">RUSH</span>' : ''}${j.contact_name ? ' · ' + esc(j.contact_name) : ''}</div></td>
    <td class="num">${j.unsized ? '<span class="dim">—</span>' : hrs(j.minutes)}</td>
    <td>${j.due ? fmtDate(j.due) : '<span class="dim">—</span>'}</td>
    <td>${j.projectedFinish ? `<strong style="color:${late ? 'var(--amber)' : 'var(--txt)'}">${fmtDate(j.projectedFinish)}</strong>` : '<span class="dim">—</span>'}</td>
    <td class="num">${status}</td>
  </tr>`
}

function wire(d) {
  onOnce($('#view'), '[data-job]', (_e, el) => go(`/jobs/${el.dataset.job}`))

  const runPromise = () => {
    const pieces = Number($('#pq')?.value) || 0
    const colors = Number($('#pc')?.value) || 1
    const due = $('#pd')?.value || ''
    const out = $('#promise-out')
    if (!pieces) { out.innerHTML = '<div class="dim" style="font-size:12.5px">Enter a piece count.</div>'; return }
    api.post('/api/capacity/promise', { pieces, colors, due_date: due }).then((r) => {
      const shipStr = r.earliestFinish ? fmtDate(r.earliestFinish) : '—'
      const cushion = r.slackDays
      let verdict, cls, note
      if (!due) { verdict = `Earliest ship: ${shipStr}`; cls = 'ok'; note = `${r.hours}h of press time · ${r.workingDaysOut} working day${r.workingDaysOut === 1 ? '' : 's'} out` }
      else if (r.feasible) { verdict = `Yes — ships by ${shipStr}`; cls = 'ok'; note = cushion > 0 ? `${cushion} working day${cushion === 1 ? '' : 's'} of cushion before ${fmtDate(due)}` : `lands exactly on ${fmtDate(due)} — no slack` }
      else { verdict = `Not by ${fmtDate(due)}`; cls = 'no'; note = `earliest is ${shipStr} — ${Math.abs(cushion)} working day${Math.abs(cushion) === 1 ? '' : 's'} short. Quote a later date, add a press, or run overtime.` }
      out.innerHTML = `<div class="promise-verdict ${cls}"><div class="pv-main">${esc(verdict)}</div><div class="pv-note">${esc(note)}</div></div>`
    }).catch((e) => { out.innerHTML = `<div class="dim">${esc(e.message)}</div>` })
  }
  ;['#pq', '#pc', '#pd'].forEach((sel) => on($(sel).closest('.promise-grid'), sel, () => { clearTimeout(promiseTimer); promiseTimer = setTimeout(runPromise, 250) }, 'input'))
  runPromise()

  $('#model-toggle').onclick = () => { const e = $('#model-edit'); e.hidden = !e.hidden }
  $('#model-save').onclick = async () => {
    const body = { capacity_stations: $('#ms').value, capacity_hours_per_day: $('#mh').value, utilization_pct: $('#mu').value }
    try { render(await api.put('/api/capacity/settings', body)); toast('Capacity updated') }
    catch (e) { toast(e.message, true) }
  }
}

/** A sensible default target for the promise tool — the coming Friday. */
function nextFriday() {
  const d = new Date(`${today()}T12:00:00`)
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7))
  return d.toISOString().slice(0, 10)
}
