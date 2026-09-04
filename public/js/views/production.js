/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4 */
import { api, $, $$, esc, setPage, toast, modal, closeModal, go, fmtDate, onOnce } from '../core.js'
const stages = ['new', 'art_approval', 'prepress', 'production', 'qc', 'shipping']
const options = (values, current) =>
  values
    .map(
      (v) =>
        `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(v.replaceAll('_', ' '))}</option>`
    )
    .join('')
const staff = (members, id) =>
  `<option value="">Any team member</option>${members
    .filter((m) => m.status === 'active')
    .map((m) => `<option value="${m.id}" ${m.id === id ? 'selected' : ''}>${esc(m.name)}</option>`)
    .join('')}`
let fieldId = 0
const field = (label, html) => {
  const id = `prod-field-${++fieldId}`
  return `<label class="field" for="${id}">${esc(label)}${html.replace(/<(input|select|textarea) /, `<$1 id="${id}" `)}</label>`
}
const input = (name, value = '', type = 'text') =>
  `<input class="input" name="${name}" type="${type}" value="${esc(value)}">`
const collect = (el) => Object.fromEntries(new FormData(el))
function buttons() {
  return '<button class="btn ghost" id="prod-focus">Focus mode</button><a class="btn ghost" href="#/scan">Scan / find</a>'
}
function focus() {
  document.body.classList.toggle('production-focus')
  $('#prod-focus').textContent = document.body.classList.contains('production-focus')
    ? 'Exit focus'
    : 'Focus mode'
}
window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/production')) document.body.classList.remove('production-focus')
})
export async function productionView() {
  const query = location.hash.split('?')[1] || '',
    d = await api.get(`/api/production?${query}`)
  setPage(
    'Production',
    buttons() + (d.manager ? '<a class="btn" href="#/production/workflows">Edit workflows</a>' : ''),
    'Department queue'
  )
  $('#view').innerHTML =
    `<div class="stack production-page"><form id="prod-filter" class="prod-toolbar">${field('Department', `<select class="input" name="department"><option value="">All departments</option>${options(d.departments, d.department)}</select>`)}<label><input type="checkbox" name="mine" ${new URLSearchParams(query).get('mine') === '1' ? 'checked' : ''}> Assigned to me</label><button class="btn">Show queue</button><button class="btn ghost" type="button" id="prod-default">Make my start page</button></form>
    <p class="dim">${d.rows.filter((r) => !r.blocked).length} ready · ${d.rows.filter((r) => r.blocked).length} waiting. Open a job to see counts, artwork, instructions and its next task.</p>
    <div class="prod-queue">${d.rows.length ? d.rows.map((r) => `<a class="prod-queue-row" href="#/production/jobs/${r.job_id}"><div><span class="mono">${esc(r.job_number)}</span>${r.rush ? ' · RUSH' : ''}<h3>${esc(r.task.title)}</h3><span>${esc(r.title)}</span></div><div><strong>${esc(r.task.department)}</strong><div class="dim">${esc(d.members.find((m) => m.id === r.task.assigned_id)?.name || 'Unassigned')}${r.due_date ? ` · due ${esc(fmtDate(r.due_date))}` : ''}</div><div class="${r.blocked ? 'dim' : 'prod-ready'}">${esc(r.blocked || 'Ready to work')}</div></div></a>`).join('') : '<div class="card card-b">No open tasks in this queue. Add a workflow from a job’s Production tasks screen.</div>'}</div>
    ${d.manager ? `<details class="card card-b"><summary>Automatic tasks for new jobs</summary><p>Match a workflow by decoration text. Existing jobs keep their current process. For recurring combinations, save a combined template once. For one-off combinations, select multiple workflows on the job.</p><label><input id="prod-auto" type="checkbox" ${d.auto ? 'checked' : ''}> Apply matching workflows automatically</label></details>` : ''}</div>`
  $('#prod-focus').onclick = focus
  $('#prod-filter').onsubmit = (e) => {
    e.preventDefault()
    const f = collect(e.target)
    location.hash = `#/production?department=${encodeURIComponent(f.department)}${f.mine ? '&mine=1' : ''}`
  }
  $('#prod-default').onclick = async () => {
    await api.put('/api/production/preference', { department: $('#prod-filter select').value })
    toast('Department start page saved')
  }
  if ($('#prod-auto'))
    $('#prod-auto').onchange = async (e) => {
      try {
        await api.put('/api/production/auto', { enabled: e.target.checked })
        toast('New-job workflow setting saved')
      } catch (err) {
        e.target.checked = !e.target.checked
        toast(err.message, true)
      }
    }
}
export async function productionJobView(id) {
  const d = await api.get(
      `/api/production/jobs/${id}${location.hash.includes('?') ? '?' + location.hash.split('?')[1] : ''}`
    ),
    j = d.job
  setPage(
    j.job_number,
    buttons() + `<a class="btn ghost" href="#/jobs/${id}">Full job</a>`,
    `<a href="#/production">Production</a> /`
  )
  const next = d.tasks.find((t) => t.status === 'pending')
  $('#view').innerHTML =
    `<div class="stack production-page"><div class="prod-job-heading"><div><h2>${esc(j.title)}</h2><p>${esc(j.decoration || '')} · ${esc(j.quantities || 'Counts below')}${j.due_date ? ` · due ${esc(fmtDate(j.due_date))}` : ''}</p><p style="white-space:pre-wrap">${esc(j.notes || '')}</p></div><button id="prod-label" class="btn ghost">Print QR label</button></div>
    ${next ? `<section class="card card-b prod-next"><span class="dim">NEXT TASK · ${esc(next.department)}</span><h2>${esc(next.title)}</h2><p>${esc(d.members.find((m) => m.id === next.assigned_id)?.name || 'Available to department')}</p>${next.blocked ? `<p role="status">${esc(next.blocked)}</p>` : `<button class="btn primary" data-task-action="complete" data-task-id="${next.id}">Complete task</button>`}</section>` : d.tasks.length ? '<p class="prod-ready">All tasks resolved.</p>' : '<p>No task workflow on this job yet.</p>'}
    ${!d.tasks.length && d.manager ? '<button class="btn" id="prod-apply">Choose workflow</button>' : ''}
    <section class="card"><div class="card-h"><h3>Task sequence</h3>${d.manager ? '<button class="btn ghost" id="prod-add-task">Add task</button>' : ''}</div><div class="card-b">${d.tasks.map((t) => `<div class="prod-task"><div><strong>${esc(t.title)}</strong><div class="dim">${esc(t.department)} · ${esc(d.members.find((m) => m.id === t.assigned_id)?.name || 'Unassigned')} · ${esc(t.status)}${t.completed_by ? ` by ${esc(t.completed_by)}` : ''}</div>${t.note ? `<p>${esc(t.note)}</p>` : ''}</div>${d.manager ? `<div class="prod-actions">${t.status === 'pending' ? `<button class="btn ghost" data-edit-task="${t.id}">Edit</button><button class="btn ghost" data-task-action="skip" data-task-id="${t.id}">Skip</button>` : `<button class="btn ghost" data-task-action="reopen" data-task-id="${t.id}">Reopen</button>`}</div>` : ''}</div>`).join('')}</div></section>
    <details class="card card-b" ${next?.gate === 'receiving' ? 'open' : ''}><summary>Receiving & garment counts</summary><p>Enter total received so far for each size. Shortages stay open until received or resolved by a manager.</p>${
      d.pos.length
        ? d.pos
            .map(
              (po) =>
                `<form data-receive-po="${po.id}" class="prod-receive"><h3>${esc(po.po_number)} · ${esc(po.status)}</h3>${d.manager ? `<button type="button" class="btn ghost" data-supplier-check="${po.id}">Refresh supplier status</button>` : ''}${po.supplier_check ? `<p class="dim">Supplier checked ${esc(po.supplier_check.checked_at)}</p>${supplierSummary(po.supplier_check.payload)}` : ''}${po.lines.map((l) => field(`${l.style || l.sku || 'Garment'} · ${l.color || ''} · ${l.size || ''} / ${l.qty_ordered} ordered`, input(`line_${l.id}`, l.qty_received, 'number'))).join('')}<button class="btn">Save counts</button></form>`
            )
            .join('')
        : `<form id="prod-counts"><p>Customer-supplied or manually purchased garments. Count by size.</p><div class="prod-fields">${Object.entries(
            JSON.parse(j.sizes || '{}')
          )
            .filter(([, n]) => n > 0)
            .map(([size, n]) =>
              field(size + ' / ' + n + ' expected', input(size, d.counts[size] || 0, 'number'))
            )
            .join('')}</div><button class="btn">Save received totals</button></form>`
    }</details>
    <details class="card card-b" ${next?.stage === 'shipping' ? 'open' : ''}><summary>Outgoing shipments / collection</summary>${d.shipments.map((p) => `<p>${esc(p.carrier)} · ${esc(p.tracking_number)}<br>${esc(p.note)} · ${esc(p.created_at)}</p>`).join('') || '<p>No shipment recorded.</p>'}<form id="prod-shipment"><div class="prod-fields">${field('Carrier or pickup method', input('carrier'))}${field('Tracking / collection reference', input('tracking_number'))}${field('Shipment notes', input('note'))}</div><button class="btn">Record shipment</button></form><p class="dim">Tracking is recorded manually here. Open your carrier’s tracking service for delivery updates.</p></details>
    <details class="card card-b"><summary>Artwork</summary>${d.art.map((a) => `<p>Version ${a.version} · ${esc(a.status)} · <a href="${esc(a.url)}" target="_blank" rel="noopener">View artwork</a></p>`).join('') || '<p>No artwork attached.</p>'}</details>
    <details class="card card-b"><summary>Task history</summary>${d.events.map((e) => `<p>${esc(e.created_at)} · ${esc(e.actor)} · ${esc(e.action)}<br><small>${esc(e.detail)}</small></p>`).join('') || '<p>No task activity yet.</p>'}</details></div>`
  $('#prod-focus').onclick = focus
  $('#prod-label').onclick = () =>
    modal({
      title: 'Job label',
      body: `<div class="prod-label"><img src="/api/production/jobs/${id}/qr" alt="QR code for ${esc(j.job_number)}" width="220" height="220"><h2>${esc(j.job_number)}</h2><p>${esc(j.title)}</p><p>Scan with your phone camera. Staff sign-in required.<br>Or enter the job number in Floor Mode.</p></div>`,
      footer: '<button class="btn" id="prod-print">Print label</button>',
      onMount: (bg) => ($('#prod-print', bg).onclick = () => window.print())
    })
  if ($('#prod-apply'))
    $('#prod-apply').onclick = async () => {
      const t = await api.get('/api/production/templates')
      modal({
        title: 'Choose work on this job',
        body: `<form id="prod-choose">${t.templates
          .filter((t) => !t.archived)
          .map(
            (t) =>
              `<label class="prod-choice"><input type="checkbox" name="flow" value="${t.id}"> ${esc(t.name)}</label>`
          )
          .join(
            ''
          )}<p>Choose more than one for combination work. Shared tasks are combined; edit the sequence afterwards.</p></form>`,
        footer: '<button class="btn" id="prod-use">Apply workflows</button>',
        onMount: (bg) =>
          ($('#prod-use', bg).onclick = async () => {
            try {
              await api.post(`/api/production/jobs/${id}/workflow`, {
                revision: d.revision,
                template_ids: $$('input:checked', bg).map((e) => +e.value)
              })
              closeModal()
              productionJobView(id)
            } catch (e) {
              toast(e.message, true)
            }
          })
      })
    }
  if ($('#prod-add-task')) $('#prod-add-task').onclick = () => editJobTask(id, d, null)
  $$('[data-edit-task]').forEach(
    (b) =>
      (b.onclick = () =>
        editJobTask(
          id,
          d,
          d.tasks.find((t) => t.id === +b.dataset.editTask)
        ))
  )
  $$('[data-task-action]').forEach(
    (b) =>
      (b.onclick = () => {
        const action = b.dataset.taskAction,
          task = +b.dataset.taskId
        modal({
          title:
            action === 'complete' ? 'Complete this task?' : `${action === 'skip' ? 'Skip' : 'Reopen'} task`,
          body: `<label class="field">${action === 'complete' ? 'Completion note (optional)' : 'Reason (required)'}<textarea id="prod-note" class="input" maxlength="1000"></textarea></label>`,
          footer: `<button class="btn" id="prod-confirm">${action === 'complete' ? 'Complete task' : action === 'skip' ? 'Skip task' : 'Reopen task'}</button>`,
          onMount: (bg) =>
            ($('#prod-confirm', bg).onclick = async (e) => {
              e.target.disabled = true
              try {
                await api.post(`/api/production/jobs/${id}/tasks/${task}/action`, {
                  revision: d.revision,
                  action,
                  note: $('#prod-note', bg).value
                })
                closeModal()
                await productionJobView(id)
                toast('Task updated')
              } catch (err) {
                toast(err.message, true)
                e.target.disabled = false
              }
            })
        })
      })
  )
  if ($('#prod-counts'))
    $('#prod-counts').onsubmit = async (e) => {
      e.preventDefault()
      try {
        await api.post(`/api/production/jobs/${id}/counts`, {
          revision: d.revision,
          counts: Object.fromEntries(
            Object.entries(collect(e.target)).map(([k, v]) => [k, v.trim() === '' ? null : Number(v)])
          )
        })
        await productionJobView(id)
        toast('Received totals saved')
      } catch (err) {
        toast(err.message, true)
      }
    }
  $('#prod-shipment').onsubmit = async (e) => {
    e.preventDefault()
    try {
      await api.post(`/api/production/jobs/${id}/shipments`, { ...collect(e.target), revision: d.revision })
      await productionJobView(id)
      toast('Shipment recorded')
    } catch (err) {
      toast(err.message, true)
    }
  }
  $$('[data-supplier-check]').forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true
        try {
          await api.post(`/api/purchase-orders/${b.dataset.supplierCheck}/supplier-check`, {})
          await productionJobView(id)
        } catch (e) {
          toast(e.message, true)
          b.disabled = false
        }
      })
  )
  $$('[data-receive-po]').forEach(
    (f) =>
      (f.onsubmit = async (e) => {
        e.preventDefault()
        try {
          const counts = Object.entries(collect(f)).map(([k, v]) => ({
            line_id: +k.slice(5),
            qty_received: v.trim() === '' ? null : Number(v)
          }))
          await api.post(`/api/production/jobs/${id}/receive/${f.dataset.receivePo}`, {
            revision: d.revision,
            counts
          })
          await productionJobView(id)
          toast('Counts saved')
        } catch (err) {
          toast(err.message, true)
        }
      })
  )
}
function taskFields(t, members) {
  return `${field('Task', input('title', t.title || ''))}${field('Department', input('department', t.department || 'Production'))}${field('Board stage', `<select class="input" name="stage">${options(stages, t.stage || 'production')}</select>`)}${field('Assigned employee', `<select class="input" name="assigned_id">${staff(members, t.assigned_id)}</select>`)}${field('Requirement', `<select class="input" name="gate"><option value="">None</option><option value="receiving" ${t.gate === 'receiving' ? 'selected' : ''}>Garments received / counted</option><option value="approval" ${t.gate === 'approval' ? 'selected' : ''}>Artwork approval</option></select>`)}`
}
function editJobTask(id, d, t) {
  modal({
    title: t ? 'Edit task' : 'Add task',
    body: `<form id="prod-edit-task" class="prod-fields">${taskFields(t || {}, d.members)}${field('Order (lower comes first)', input('position', t?.position ?? d.tasks.length, 'number'))}</form>`,
    footer: '<button class="btn" id="prod-save-task">Save task</button>',
    onMount: (bg) =>
      ($('#prod-save-task', bg).onclick = async () => {
        try {
          const b = collect($('#prod-edit-task', bg))
          b.assigned_id = b.assigned_id ? +b.assigned_id : null
          b.position = +b.position
          b.revision = d.revision
          await api.req(t ? 'PUT' : 'POST', `/api/production/jobs/${id}/tasks${t ? `/${t.id}` : ''}`, b)
          closeModal()
          productionJobView(id)
        } catch (e) {
          toast(e.message, true)
        }
      })
  })
}
export async function workflowsView() {
  const d = await api.get('/api/production/templates')
  setPage(
    'Workflows',
    d.manager ? '<button class="btn" id="prod-new-flow">New workflow</button>' : '',
    '<a href="#/production">Production</a> /'
  )
  $('#view').innerHTML =
    `<div class="stack production-page"><p>Define the work once. Each job keeps its own editable copy. Use a workflow for screen printing, embroidery, DTF, laser or any service you offer.</p>${d.templates.map((t) => `<section class="card card-b"><div class="row"><h2>${esc(t.name)}</h2>${d.manager ? `<button class="btn ghost" data-edit-flow="${t.id}">Edit workflow</button>` : ''}</div><p class="dim">${t.archived ? 'Archived' : `Auto-match decoration containing “${esc(t.match_text)}”`} · Revision ${t.revision}</p><ol>${t.steps.map((s) => `<li>${esc(s.title)} <span class="dim">· ${esc(s.department)}</span></li>`).join('')}</ol></section>`).join('')}</div>`
  if ($('#prod-new-flow')) $('#prod-new-flow').onclick = () => editFlow(null, d.members)
  $$('[data-edit-flow]').forEach(
    (b) =>
      (b.onclick = () =>
        editFlow(
          d.templates.find((t) => t.id === +b.dataset.editFlow),
          d.members
        ))
  )
}
function editFlow(t, members) {
  const steps = (
    t?.steps || [
      { title: 'Complete work', department: 'Production', stage: 'production', gate: '', assigned_id: null }
    ]
  ).map((s) => ({ ...s }))
  modal({
    title: t ? 'Edit workflow' : 'New workflow',
    wide: true,
    body: `<form id="prod-flow"><div class="prod-fields">${field('Workflow name', input('name', t?.name || ''))}${field('Auto-match decoration text', input('match_text', t?.match_text || ''))}</div><label><input type="checkbox" name="archived" ${t?.archived ? 'checked' : ''}> Archive for future jobs</label><div id="prod-steps"></div><button type="button" class="btn ghost" id="prod-add-step">Add step</button></form>`,
    footer: '<button class="btn" id="prod-save-flow">Save workflow</button>',
    onMount: (bg) => {
      const read = () =>
        $$('[data-flow-step]', bg).forEach((el, i) => {
          for (const input of $$('input,select', el))
            steps[i][input.name] =
              input.name === 'assigned_id' ? (input.value ? +input.value : null) : input.value
        })
      const draw = () => {
        $('#prod-steps', bg).innerHTML = steps
          .map(
            (s, i) =>
              `<fieldset class="prod-fields" data-flow-step="${i}"><legend>Step ${i + 1}</legend>${taskFields(s, members)}<div class="prod-actions"><button type="button" class="btn ghost" data-step-up="${i}" ${i === 0 ? 'disabled' : ''}>Move up</button><button type="button" class="btn ghost" data-step-remove="${i}" ${steps.length === 1 ? 'disabled' : ''}>Remove</button></div></fieldset>`
          )
          .join('')
        $$('[data-step-up]', bg).forEach(
          (b) =>
            (b.onclick = () => {
              read()
              const i = +b.dataset.stepUp
              ;[steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]
              draw()
            })
        )
        $$('[data-step-remove]', bg).forEach(
          (b) =>
            (b.onclick = () => {
              read()
              steps.splice(+b.dataset.stepRemove, 1)
              draw()
            })
        )
      }
      draw()
      $('#prod-add-step', bg).onclick = () => {
        read()
        steps.push({ title: '', department: 'Production', stage: 'production', gate: '', assigned_id: null })
        draw()
      }
      $('#prod-save-flow', bg).onclick = async () => {
        read()
        const form = $('#prod-flow', bg)
        try {
          await api.req(t ? 'PUT' : 'POST', `/api/production/templates${t ? `/${t.id}` : ''}`, {
            name: form.elements.name.value,
            match_text: form.elements.match_text.value,
            archived: form.elements.archived.checked,
            revision: t?.revision,
            steps
          })
          closeModal()
          workflowsView()
          toast('Workflow saved. Existing jobs keep their tasks.')
        } catch (e) {
          toast(e.message, true)
        }
      }
    }
  })
}

function supplierSummary(payload) {
  try {
    const d = JSON.parse(payload)
    return `<div>${d.orders.map((o) => `<p>${esc(o.order_number)} · ${esc(o.status)} ${esc(o.issue)}</p>`).join('')}${d.shipments.map((p) => `<p>${esc(p.carrier)} · ${esc(p.tracking_number)} · shipped ${esc(p.ship_date)}</p>`).join('')}${d.errors.map((e) => `<p>${esc(e.service)}: ${esc(e.error)}</p>`).join('')}${!d.orders.length && !d.shipments.length ? '<p>No matching supplier records returned. Check the PO reference in the supplier portal.</p>' : ''}</div>`
  } catch {
    return ''
  }
}
