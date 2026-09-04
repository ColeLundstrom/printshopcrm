/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4 */
import { api, $, esc, setPage, fmtDate } from '../core.js'
const iso = d => d.toISOString().slice(0,10)
const day = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return iso(d) }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
export async function calendarView() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '')
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : today()
  const parsed = new Date(anchor + 'T12:00:00Z')
  if (!Number.isFinite(+parsed)) throw new Error('Choose a valid calendar date.')
  const mode = ['week','agenda'].includes(q.get('view')) ? q.get('view') : 'month'
  const first = anchor.slice(0,7) + '-01'
  const weekStart = value => day(value, -(new Date(value+'T12:00:00Z').getUTCDay()+6)%7)
  const start = mode === 'week' ? weekStart(anchor) : weekStart(first)
  const end = day(start, mode === 'week' ? 6 : 41)
  const department = q.get('department') || ''
  const d = await api.get(`/api/production/calendar?${new URLSearchParams({start,end,department,mine:q.get('mine') || ''})}`)
  const href = updates => { const next = new URLSearchParams(q); for (const [k,v] of Object.entries(updates)) next.set(k,v); return '#/calendar?' + next }
  const move = amount => {
    if (mode === 'week') return day(anchor, 7*amount)
    const date = new Date(first + 'T12:00:00Z'); date.setUTCMonth(date.getUTCMonth()+amount); return iso(date)
  }
  const label = mode === 'week' ? `${fmtDate(start)} – ${fmtDate(end)}` : new Intl.DateTimeFormat(undefined, {month:'long',year:'numeric',timeZone:'UTC'}).format(parsed)
  setPage('Job calendar', '<a class="btn ghost" href="#/board">Card board</a><a class="btn ghost" href="#/production">Department queue</a>')
  const event = e => `<a class="cal-event cal-${e.kind}" href="#/production/jobs/${e.job_id}" title="${esc(e.job_number+' · '+e.title+' · '+e.label)}"><strong>${esc(e.job_number)}${e.rush ? ' · RUSH' : ''}</strong><span>${esc(e.title)}</span><small>${esc(e.label)}${e.department ? ' · '+esc(e.department) : ''}</small></a>`
  const days = Array.from({length: mode === 'week' ? 7 : 42}, (_,i) => day(start,i))
  const byDate = new Map(days.map(date => [date, d.events.filter(e => e.date === date)]))
  $('#view').innerHTML = `<div class="calendar-page"><div class="cal-toolbar"><div class="cal-nav"><a class="btn ghost" href="${esc(href({date:move(-1)}))}" aria-label="Previous ${mode === 'week' ? 'week' : 'month'}">Previous</a><a class="btn ghost" href="${esc(href({date:today()}))}">Today</a><a class="btn ghost" href="${esc(href({date:move(1)}))}" aria-label="Next ${mode === 'week' ? 'week' : 'month'}">Next</a></div><h2>${esc(label)}</h2><div class="cal-nav" aria-label="Calendar display">${['month','week','agenda'].map(v => `<a class="btn ${v === mode ? '' : 'ghost'}" ${v === mode ? 'aria-current="page"' : ''} href="${esc(href({view:v}))}">${v[0].toUpperCase()+v.slice(1)}</a>`).join('')}</div></div>
  <form id="cal-filter" class="cal-toolbar"><label class="field">Department<select class="input" name="department"><option value="">All departments</option>${d.departments.map(dep => `<option ${dep===department?'selected':''}>${esc(dep)}</option>`).join('')}</select></label><label><input type="checkbox" name="mine" ${q.get('mine')==='1'?'checked':''}> Assigned to me</label><button class="btn ghost">Apply filters</button></form>
  <p class="dim">${d.event_count} date entries · Job due, planned production, and pending task targets. Open any entry to adjust its timeline. Timing never blocks task completion.</p>
  ${d.truncated ? '<p role="alert">More than 5,000 entries match. Showing the first 5,000; narrow the date range or department to see the rest.</p>' : ''}
  <div class="cal-grid ${mode==='agenda'?'cal-hidden':''}"><div class="cal-weekdays">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(v=>`<span>${v}</span>`).join('')}</div><div class="cal-days">${days.map(date=>`<section class="cal-day ${date===today()?'cal-today':''} ${date.slice(0,7)!==anchor.slice(0,7)?'cal-outside':''}"><h3><time datetime="${date}">${Number(date.slice(-2))}</time></h3>${byDate.get(date).slice(0,5).map(event).join('')}${byDate.get(date).length>5?`<a href="${esc(href({view:'agenda'}))}">${byDate.get(date).length-5} more · agenda</a>`:''}</section>`).join('')}</div></div>
  <div class="cal-agenda ${mode==='agenda'?'cal-force':''}">${days.filter(date=>byDate.get(date).length).map(date=>`<section><h3>${esc(fmtDate(date))}</h3><div class="cal-agenda-items">${byDate.get(date).map(event).join('')}</div></section>`).join('') || '<p class="card card-b">No jobs or tasks scheduled in this range.</p>'}</div>
  <details class="card card-b" ${!d.events.length?'open':''}><summary>Unscheduled jobs · ${d.unscheduled_count}</summary><p class="dim">These jobs have no customer due date or active timeline target. Open one to add optional timing.</p><div class="cal-unscheduled">${d.unscheduled.map(j=>`<a href="#/production/jobs/${j.job_id}">${esc(j.job_number)} · ${esc(j.title)}</a>`).join('') || '<p>Every matching job has at least one date.</p>'}</div>${d.unscheduled_count>100?'<p>Showing 100; use a department filter or the card board for the rest.</p>':''}</details></div>`
  $('#cal-filter').onsubmit = e => { e.preventDefault(); const f=new FormData(e.target); location.hash=href({department:f.get('department'),mine:f.get('mine')?'1':'0'}) }
}
