/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4 */
import { api, $, $$, esc, money, setPage, toast, modal, closeModal, go } from '../core.js'
let seq = 0
const field = (name, title, value = '', type = 'number') => {
  const id = 'cost-field-' + ++seq
  return `<label class="field" for="${id}">${esc(title)}<input id="${id}" class="input" name="${name}" type="${type}" value="${esc(value ?? '')}" ${type === 'number' ? 'min="0" step="any"' : ''}></label>`
}
const data = (f) => Object.fromEntries(new FormData(f))
const num = (v) => (v.trim() === '' ? null : Number(v))
export async function costingSettingsView() {
  const d = await api.get('/api/costing/config'),
    s = d.settings
  setPage(
    'Shop costs & machines',
    '<a class="btn ghost" href="#/costing">Cost comparison</a>',
    '<a href="#/roi">Profitability</a> /'
  )
  $('#view').innerHTML =
    `<div class="stack production-page"><p>Set the costs and output your shop actually runs. Machine cost excludes employee pay and shared shop overhead. Saved operations keep their rate snapshot when these settings change.</p><section class="card card-b"><h2>Shop capacity & overhead</h2><form id="cost-settings"><div class="prod-fields">${field('hours_day', 'Shop hours per day', s.hours_day)}${field('days_week', 'Working days per week', s.days_week)}${field('overhead_month', 'Shared overhead per month', s.overhead_month)}${field('productive_pct', 'Productive machine time (%)', s.productive_pct)}</div><p class="dim">Overhead is spread over active machines’ scheduled productive hours. Current allocation: ${d.overhead_rate === null ? 'Add a machine first' : money(d.overhead_rate) + ' per productive machine hour'}. Avoid counting the same cost in machine costs and overhead.</p><h3>Employee loaded hourly costs</h3><p class="dim">Include wage and employer costs. These settings require manager access.</p><div class="prod-fields">${d.members
      .filter((m) => m.status === 'active')
      .map((m) =>
        field('member_' + m.id, m.name, d.employees.find((r) => r.member_id === m.id)?.hourly_cost ?? '')
      )
      .join(
        ''
      )}</div><button class="btn">Save shop costs</button></form></section><section class="card card-b"><div class="row"><h2>Machines / workstations</h2><button class="btn" id="cost-add-machine">Add machine</button></div>${d.machines.map((m) => `<div class="prod-task"><div><strong>${esc(m.name)}</strong> · ${esc(m.method)}${!m.active ? ' · archived' : ''}<p class="dim">${m.output_hour} units/hour · ${m.setup_minutes} min setup · ${m.hours_week} hours/week · ${money(m.hourly_cost)}/hour</p></div><button class="btn ghost" data-machine="${m.id}">Edit</button></div>`).join('') || '<p>Add each press, embroidery machine, DTF station or finishing workstation.</p>'}</section></div>`
  $('#cost-settings').onsubmit = async (e) => {
    e.preventDefault()
    const f = data(e.target)
    try {
      await api.put('/api/costing/config', {
        settings: Object.fromEntries(
          ['hours_day', 'days_week', 'overhead_month', 'productive_pct'].map((k) => [k, num(f[k])])
        ),
        employees: d.members
          .filter((m) => m.status === 'active' && f['member_' + m.id]?.trim())
          .map((m) => ({ member_id: m.id, hourly_cost: num(f['member_' + m.id]) }))
      })
      toast('Shop costs saved')
      costingSettingsView()
    } catch (err) {
      toast(err.message, true)
    }
  }
  $('#cost-add-machine').onclick = () => machineForm(null, s)
  $$('[data-machine]').forEach(
    (b) =>
      (b.onclick = () =>
        machineForm(
          d.machines.find((m) => m.id === +b.dataset.machine),
          s
        ))
  )
}
function machineForm(m, s) {
  modal({
    title: m ? 'Edit machine' : 'Add machine',
    body: `<form id="cost-machine"><div class="prod-fields">${field('name', 'Machine / workstation name', m?.name || '', 'text')}${field('method', 'Decoration method', m?.method || 'Screen printing', 'text')}${field('hourly_cost', 'Machine operating cost / hour', m?.hourly_cost ?? 0)}${field('output_hour', 'Expected finished units / hour', m?.output_hour ?? '')}${field('setup_minutes', 'Setup minutes per run', m?.setup_minutes ?? 0)}${field('hours_week', 'Scheduled hours / week', m?.hours_week ?? s.hours_day * s.days_week)}</div><label><input type="checkbox" name="active" ${m?.active === 0 ? '' : 'checked'}> Active machine</label></form>`,
    footer: '<button class="btn" id="cost-save-machine">Save machine</button>',
    onMount: (bg) =>
      ($('#cost-save-machine', bg).onclick = async () => {
        const f = data($('#cost-machine', bg))
        try {
          await api.req(m ? 'PUT' : 'POST', '/api/costing/machines' + (m ? '/' + m.id : ''), {
            ...f,
            active: !!f.active,
            revision: m?.revision,
            ...Object.fromEntries(
              ['hourly_cost', 'output_hour', 'setup_minutes', 'hours_week'].map((k) => [k, num(f[k])])
            )
          })
          closeModal()
          costingSettingsView()
        } catch (e) {
          toast(e.message, true)
        }
      })
  })
}
export async function jobCostingView(id) {
  const [d, c] = await Promise.all([api.get(`/api/costing/jobs/${id}`), api.get('/api/costing/config')])
  setPage(
    `${d.job.job_number} · Job margin`,
    '<a class="btn ghost" href="#/costing/settings">Cost settings</a>',
    `<a href="#/jobs/${id}">Job</a> /`
  )
  $('#view').innerHTML =
    `<div class="stack production-page"><h2>${esc(d.job.title)}</h2><div class="card card-b"><div class="prod-toolbar"><div>Net sales before tax<h2>${money(d.revenue)}</h2></div><div>Modeled total cost<h2>${money(d.cost)}</h2></div><div>Job profit<h2>${money(d.profit)}</h2></div><div>Margin<h2>${d.margin === null ? '—' : d.margin + '%'}</h2></div></div><p class="dim">${esc(d.basis)} · ${esc(d.material_basis)}. Profit is sales less modeled costs, not cash received. Shared overhead is included in saved operation rates.</p></div><section class="card card-b"><h3>Materials & other costs</h3><form id="cost-job"><label><input name="customer_supplied" type="checkbox" ${d.customer_supplied ? 'checked' : ''}> Customer supplies garments (blank cost = 0)</label><div class="prod-fields">${field('material_cost', 'Total garment cost (blank = quote/catalog estimate)', d.material_cost)}${field('consumable_cost', 'Decoration supplies / outside decoration (blank = estimate)', d.consumable_cost)}${field('other_cost', 'Other job costs: freight, fees, outside work', d.other_cost)}</div><p>Materials ${money(d.breakdown.materials)} · Operations ${money(d.breakdown.operations)} · Decoration ${money(d.breakdown.consumables)} · Other ${money(d.breakdown.other)}</p><p class="dim">${esc(d.consumable_basis)} Do not include outside labor again as an in-house operation.</p><button class="btn">Save job costs</button></form></section><section class="card card-b"><div class="row"><h3>Runs by machine & employee</h3><button class="btn" id="cost-add-operation">Add operation</button></div><p class="dim">Record each run once. Minutes include setup and work time. Rate snapshots keep historical costs stable. Until all runs and costs are entered, this is a partial model.</p>${d.operations.map((o) => `<div class="prod-task"><div><strong>${esc(o.machine_name)}</strong> · ${esc(o.employee_name)} · ${esc(o.method)}<p>${o.units} units planned · ${o.planned_minutes.toFixed(1)} min planned · ${o.actual_minutes === null ? 'No time recorded' : o.actual_minutes + ' min recorded · ' + o.good_units + ' good units'}</p><p>${money(o.cost)} · ${esc(o.basis)}${o.output_hour !== null ? ' · ' + o.output_hour + ' good units/hour' : ''}</p></div><div class="prod-actions"><button class="btn ghost" data-operation="${o.id}">Record / correct</button><button class="btn ghost" data-void-operation="${o.id}">Void</button></div></div>`).join('') || '<p>No machine runs yet. The legacy labor estimate is used until you add operations.</p>'}</section><details class="card card-b"><summary>Cost history</summary>${d.events.map((e) => `<p>${esc(e.created_at)} · ${esc(e.actor)}<br><small>${esc(e.detail)}</small></p>`).join('')}</details></div>`
  $('#cost-job').onsubmit = async (e) => {
    e.preventDefault()
    const f = data(e.target)
    try {
      await api.put(`/api/costing/jobs/${id}`, {
        revision: d.revision,
        customer_supplied: !!f.customer_supplied,
        material_cost: num(f.material_cost),
        consumable_cost: num(f.consumable_cost),
        other_cost: num(f.other_cost)
      })
      toast('Job cost basis saved')
      jobCostingView(id)
    } catch (err) {
      toast(err.message, true)
    }
  }
  $('#cost-add-operation').onclick = () => operationForm(id, d, c, null)
  $$('[data-void-operation]').forEach(
    (b) =>
      (b.onclick = () =>
        modal({
          title: 'Void incorrect operation',
          body: '<label class="field">Reason<input id="cost-void-reason" class="input" maxlength="120"></label><p>The original record stays in cost history.</p>',
          footer: '<button class="btn" id="cost-void-confirm">Void operation</button>',
          onMount: (bg) =>
            ($('#cost-void-confirm', bg).onclick = async () => {
              try {
                await api.post(`/api/costing/jobs/${id}/operations/${b.dataset.voidOperation}/void`, {
                  revision: d.revision,
                  reason: $('#cost-void-reason', bg).value
                })
                closeModal()
                jobCostingView(id)
              } catch (e) {
                toast(e.message, true)
              }
            })
        }))
  )
  $$('[data-operation]').forEach(
    (b) =>
      (b.onclick = () =>
        operationForm(
          id,
          d,
          c,
          d.operations.find((o) => o.id === +b.dataset.operation)
        ))
  )
}
function operationForm(id, d, c, o) {
  if (!c.machines.some((m) => m.active)) {
    toast('Add a machine and employee hourly costs first.')
    go('/costing/settings')
    return
  }
  modal({
    title: o ? 'Record or correct operation' : 'Plan an operation',
    wide: true,
    body: `<form id="cost-op"><div class="prod-fields"><label class="field">Machine<select name="machine_id" class="input">${c.machines
      .filter((m) => m.active)
      .map(
        (m) => `<option value="${m.id}" ${m.id === o?.machine_id ? 'selected' : ''}>${esc(m.name)}</option>`
      )
      .join(
        ''
      )}</select></label><label class="field">Employee<select name="member_id" class="input">${c.members
      .filter((m) => m.status === 'active')
      .map(
        (m) => `<option value="${m.id}" ${m.id === o?.member_id ? 'selected' : ''}>${esc(m.name)}</option>`
      )
      .join(
        ''
      )}</select></label>${field('units', 'Units in this run', o?.units ?? '')}${field('planned_minutes', 'Planned minutes (blank = machine output + setup)', o?.planned_minutes)}${field('actual_minutes', 'Actual minutes including setup (blank = not recorded)', o?.actual_minutes)}${field('good_units', 'Good units completed (blank = not recorded)', o?.good_units)}</div><label class="field">${o ? 'Correction reason' : 'Notes'}<textarea class="input" name="note" maxlength="1000"></textarea></label></form>`,
    footer: '<button class="btn" id="cost-save-op">Save operation</button>',
    onMount: (bg) =>
      ($('#cost-save-op', bg).onclick = async () => {
        const f = data($('#cost-op', bg))
        try {
          await api.req(o ? 'PUT' : 'POST', `/api/costing/jobs/${id}/operations${o ? '/' + o.id : ''}`, {
            revision: d.revision,
            note: f.note,
            ...Object.fromEntries(
              ['machine_id', 'member_id', 'units', 'planned_minutes', 'actual_minutes', 'good_units'].map(
                (k) => [k, num(f[k])]
              )
            )
          })
          closeModal()
          jobCostingView(id)
        } catch (e) {
          toast(e.message, true)
        }
      })
  })
}
export async function costingView() {
  const query = new URLSearchParams(location.hash.split('?')[1] || '')
  const d = await api.get('/api/costing/comparison?' + query.toString())
  setPage(
    'Production cost comparison',
    '<a class="btn" href="#/costing/settings">Shop costs & machines</a>',
    '<a href="#/roi">Profitability</a> /'
  )
  $('#view').innerHTML =
    `<div class="stack production-page"><p>${esc(d.coverage)}</p><p class="dim">${esc(d.allocation)} Good units/hour measures output, not quality or difficulty; compare similar work.</p>${[
      ['machines', 'Machines'],
      ['employees', 'Employees'],
      ['methods', 'Decoration methods']
    ]
      .map(
        ([k, title]) =>
          `<section class="card card-b"><h2>${title}</h2><div style="overflow:auto"><table class="tbl"><thead><tr><th>Name</th><th>Recorded hours</th><th>Good units/hour</th><th>Modeled operation cost</th><th>Allocated profit</th><th>Planned runs</th></tr></thead><tbody>${d[k].map((r) => `<tr><td>${esc(r.name)}</td><td>${(r.recorded_minutes / 60).toFixed(2)}</td><td>${r.output_hour ?? '—'}</td><td>${money(r.cost)}</td><td>${money(r.allocated_profit)}</td><td>${r.planned_operations}</td></tr>`).join('')}</tbody></table></div>${!d[k].length ? '<p>No operations recorded yet. Open a job’s margin calculator to add a run.</p>' : ''}</section>`
      )
      .join(
        ''
      )}<section class="card card-b"><h2>Jobs with cost records</h2><p class="dim">${d.pagination.total} jobs in comparison. All pages contribute to the totals above.</p>${d.jobs.map((j) => `<p><a href="#/costing/jobs/${j.job.id}">${esc(j.job.job_number)} · ${esc(j.job.title)}</a> — ${money(j.profit)} · ${j.margin ?? '—'}% margin</p>`).join('')}${costPages(d.pagination, query)}</section></div>`
}

function costPages(p, query) {
  if (p.pages <= 1) return ''
  const link = (page, label) => {
    const q = new URLSearchParams(query)
    q.set('page', String(page))
    return `<a class="btn ghost" href="#/costing?${esc(q.toString())}">${label}</a>`
  }
  return `<nav class="prod-toolbar" aria-label="Costed job pages">${p.page > 1 ? link(p.page - 1, 'Previous') : ''}<span>Page ${p.page} of ${p.pages}</span>${p.page < p.pages ? link(p.page + 1, 'Next') : ''}</nav>`
}
