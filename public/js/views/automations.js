import { api, $, $$, el, esc, relTime, setPage, empty, toast, on, modal, closeModal, confirmModal } from '../core.js'

/**
 * Automations — GHL's model, print-shop triggers, never metered.
 *
 * The run log is the point. Shops distrust automation because they can't see what it did
 * to their customers; every fire is logged with what it sent and to whom.
 */
let cfg = null

export async function automationsView() {
  setPage('Automations', `<button class="btn ghost" id="run-tick">Run timed rules now</button><button class="btn" id="new-auto">+ New Automation</button>`)
  $('#view').innerHTML = '<div class="dim">Loading…</div>'
  const d = await api.get('/api/automations')
  cfg = d

  const trigLabel = (k) => d.triggers.find((t) => t.key === k)?.label || k
  const actLabel = (k) => d.actions.find((a) => a.key === k)?.label || k

  // #view persists across renders, so delegations live on #au-body — rebuilt each pass,
  // which is what stops the delete/toggle handlers stacking and firing N times on the Nth click.
  $('#view').innerHTML = `
    <div id="au-body">
    <div class="kpis">
      <div class="kpi"><div class="lbl">Active rules</div><div class="val">${d.stats.enabled}</div>
        <div class="sub">Unlimited on every plan</div></div>
      <div class="kpi info"><div class="lbl">Ran this week</div><div class="val">${d.stats.runs_7d}</div>
        <div class="sub">Work you didn't do by hand</div></div>
      <div class="kpi"><div class="lbl">Total fires</div><div class="val">${d.stats.total_runs}</div>
        <div class="sub">Since setup</div></div>
      <div class="kpi ${d.stats.pending ? 'info' : ''}"><div class="lbl">In a sequence</div><div class="val">${d.stats.pending || 0}</div>
        <div class="sub">${d.stats.parked ? `${d.stats.parked} stopped` : 'Waiting mid-drip'}</div></div>
    </div>

    ${(d.pending || []).length ? `<div class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>In a sequence</h3><div class="spacer"></div>
        <span class="dim" style="font-size:12px">who is mid-drip, and what is holding them up</span></div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Customer</th><th>Rule</th><th>Next step</th><th>Status</th><th class="num"></th></tr></thead>
        <tbody>${d.pending.map((p) => {
          const rule = d.automations.find((a) => a.id === p.automation_id)
          const stopped = !!p.status
          const why = p.status === 'orphaned' ? (p.note || 'the record it was about is gone')
            : p.status === 'failed' ? (p.note || 'the step kept failing')
              : rule && !rule.enabled ? 'the rule is switched off' : ''
          return `<tr data-pending="${p.id}">
            <td style="font-weight:600">${esc(p.label || '—')}</td>
            <td>${esc(p.automation_name || '')}</td>
            <td class="dim" style="font-size:12px">${stopped ? '—' : relTime(p.due_at)}</td>
            <td>${stopped || why
              ? `<span class="pill ${stopped ? 'red' : 'gray'}" title="${esc(why)}">${esc(p.status || 'paused')}</span>`
              : '<span class="pill gray">waiting</span>'}${why ? `<div class="dim" style="font-size:11px;margin-top:2px">${esc(why)}</div>` : ''}</td>
            <td class="num">${stopped ? `<button class="btn ghost sm" data-resume="${p.id}">Resume</button> ` : ''}<button class="btn ghost sm" data-cancel-seq="${p.id}">Cancel</button></td>
          </tr>`
        }).join('')}</tbody></table></div>
    </div>` : ''}

    <div class="cols">
      <div class="card">
        <div class="card-h"><h3>Rules</h3><div class="spacer"></div><span class="dim" style="font-size:12px">${d.automations.length} total</span></div>
        ${d.automations.length ? `<div>${d.automations.map((a) => `
          <div class="autorow ${a.enabled ? '' : 'off'}" data-edit="${a.id}">
            <label class="tog" data-nodrag>
              <input type="checkbox" data-toggle="${a.id}" ${a.enabled ? 'checked' : ''}><span></span>
            </label>
            <div class="au-main">
              <div class="au-name">${esc(a.name)}</div>
              <div class="au-flow">
                <span class="au-when">${esc(trigLabel(a.trigger))}${a.params?.days ? ` · ${esc(String(a.params.days))}d` : ''}${a.params?.stage ? ` · ${esc(String(a.params.stage).replace('_', ' '))}` : ''}</span>
                ${a.needs_setup ? '<span class="au-if" title="This rule names no stage, so it cannot run. Open it and choose one.">needs setup</span>' : ''}
                ${(a.conditions || []).length ? `<span class="au-if">if ${a.conditions.map((c) => `${esc(String(c.key).replace('_', ' '))} ${esc(String(c.value))}`).join(' & ')}</span>` : ''}
                <span class="au-arrow">→</span>
                ${(a.actions || []).map((x) => x.key === 'wait'
                  ? `<span class="au-wait">wait ${esc(String(x.config?.days || 1))}d</span>`
                  : `<span class="au-do">${esc(actLabel(x.key))}</span>`).join('')}
              </div>
            </div>
            <div class="au-meta">
              ${a.run_count ? `<div class="au-count">${a.run_count}×</div><div class="dim" style="font-size:10px">${relTime(a.last_run_at)}</div>` : '<div class="dim" style="font-size:10.5px">never run</div>'}
            </div>
            <button class="del" data-del="${a.id}" data-nodrag title="Delete" aria-label="Delete the automation ${esc(a.name)}">&times;</button>
          </div>`).join('')}</div>`
          : empty('⟳', 'No automations yet', 'Rules run themselves so you stop chasing people by hand.')}
      </div>

      <div class="card">
        <div class="card-h"><h3>What they did</h3><div class="spacer"></div><a class="btn ghost sm" href="#/outbox">Outbox</a></div>
        <div class="card-b" style="max-height:520px;overflow-y:auto">
          ${d.runs.length ? `<div class="tl">${d.runs.map((r) => `
            <div class="tl-i ${r.status === 'ran' ? '' : 'gray'}">
              <div class="tx" style="font-size:12.5px">
                <strong>${esc(r.automation_name || '')}</strong>
                ${r.status === 'ran' ? '' : `<span class="pill ${r.status === 'error' ? 'red' : 'gray'}">${esc(r.status)}</span>`}
              </div>
              <div class="dim" style="font-size:11.5px;margin-top:2px">${esc(r.entity_label || '')} — ${esc(r.detail || '')}</div>
              <div class="dt">${relTime(r.created_at)}${r.status === 'error' ? ` · <button class="btn ghost sm" data-retry-run="${r.id}">Try again</button>` : ''}</div>
            </div>`).join('')}</div>`
            : '<div class="dim">Nothing has fired yet. Hit “Run timed rules now” to see them work.</div>'}
        </div>
      </div>
    </div>
    </div>`

  on($('#au-body'), '[data-toggle]', async (e, t) => {
    e.stopPropagation()
    // The checkbox has ALREADY flipped before this runs. A failure that only toasted would leave
    // it showing Off on a rule that is still on and still texting customers, so the re-render is
    // outside the catch: either way the checkbox goes back to what the server says.
    try {
      await api.put(`/api/automations/${t.dataset.toggle}`, { enabled: t.checked })
      toast(t.checked ? 'Automation on' : 'Automation paused')
    } catch (err) { toast(err.message, true) }
    automationsView()
  }, 'change')

  on($('#au-body'), '[data-del]', (e, t) => {
    e.stopPropagation()
    const a = d.automations.find((x) => x.id === +t.dataset.del)
    confirmModal('Delete automation?', `“${a.name}” will stop running.`, async () => {
      await api.del(`/api/automations/${t.dataset.del}`)
      toast('Automation deleted')
      automationsView()
    })
  })

  on($('#au-body'), '[data-edit]', (e, t) => {
    if (e.target.closest('[data-nodrag]')) return
    autoForm(d.automations.find((x) => x.id === +t.dataset.edit))
  })

  on($('#au-body'), '[data-retry-run]', async (e, t) => {
    e.stopPropagation()
    try { await api.post(`/api/automations/runs/${t.dataset.retryRun}/retry`); toast('Queued — it will go again on the next sweep') }
    catch (err) { toast(err.message, true) }
    automationsView()
  })

  on($('#au-body'), '[data-resume]', async (e, t) => {
    e.stopPropagation()
    try { await api.post(`/api/automations/pending/${t.dataset.resume}/resume`); toast('Sequence resumed') }
    catch (err) { toast(err.message, true) }
    automationsView()
  })

  on($('#au-body'), '[data-cancel-seq]', (e, t) => {
    e.stopPropagation()
    const p = (d.pending || []).find((x) => x.id === +t.dataset.cancelSeq)
    confirmModal('Cancel this sequence?', `${p?.label || 'This customer'} will get no more steps of “${p?.automation_name || 'this rule'}”.`, async () => {
      await api.del(`/api/automations/pending/${t.dataset.cancelSeq}`)
      toast('Sequence cancelled')
      automationsView()
    }, 'Cancel sequence')
  })

  $('#new-auto').onclick = () => autoForm(null)
  if (new URLSearchParams(location.hash.split('?')[1] || '').get('new')) { history.replaceState(null, '', location.hash.split('?')[0]); autoForm(null) }
  $('#run-tick').onclick = async () => {
    const r = await api.post('/api/automations/tick')
    toast(r.fired.length ? `${r.fired.length} automation${r.fired.length === 1 ? '' : 's'} fired` : 'Nothing was due — already handled')
    automationsView()
  }
}

/* ---------- builder ---------- */

function autoForm(a) {
  const isNew = !a
  const state = {
    name: a?.name || '',
    trigger: a?.trigger || 'estimate.stale',
    params: { ...(a?.params || {}) },
    conditions: [...(a?.conditions || [])],
    actions: a?.actions?.length ? JSON.parse(JSON.stringify(a.actions)) : [{ key: 'email.customer', config: { subject: '', body: '' } }],
  }

  const bg = modal({
    title: isNew ? 'New Automation' : 'Edit Automation',
    wide: true,
    body: `<div class="field"><label>Name</label>
        <input class="input" id="a-name" value="${esc(state.name)}" placeholder="Chase a quote after 3 quiet days"></div>
      <div class="autobuild">
        <div class="ab-step"><div class="ab-badge when">WHEN</div><div id="ab-trigger" style="flex:1"></div></div>
        <div class="ab-step"><div class="ab-badge if">IF</div><div id="ab-conds" style="flex:1"></div></div>
        <div class="ab-step"><div class="ab-badge then">THEN</div><div id="ab-actions" style="flex:1"></div></div>
      </div>
      <div class="dim" style="font-size:11.5px;margin-top:12px">Tokens: <code>{{first_name}} {{contact_name}} {{shop_name}} {{estimate_number}} {{invoice_number}} {{job_number}} {{job_title}} {{total}} {{due_date}} {{version}} {{days}} {{stage}}</code></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="a-save">${isNew ? 'Create Automation' : 'Save'}</button>`,
    onMount: (root) => {
      const drawTrigger = () => {
        const t = cfg.triggers.find((x) => x.key === state.trigger)
        // Render what is STORED, not what the browser happens to select first. The stage dropdown
        // showed 'new' on an untouched rule while state.params went to the server empty — and a
        // stage rule with no stage used to match every stage change, so one job crossing the
        // board mailed the customer once per column, on every job in the shop.
        if (t?.param && state.params[t.param.key] == null) state.params[t.param.key] = t.param.default
        $('#ab-trigger', root).innerHTML = `
          <select class="input" id="a-trig">${cfg.triggers.map((x) => `<option value="${x.key}" ${x.key === state.trigger ? 'selected' : ''}>${esc(x.label)}${x.timed ? ' (timed)' : ''}</option>`).join('')}</select>
          ${t?.param ? `<div class="row" style="margin-top:7px;gap:7px">
            <span class="dim" style="font-size:12px">${esc(t.param.label)}</span>
            ${t.param.key === 'stage'
              ? `<select class="input" id="a-param" style="max-width:170px">${['new', 'art_approval', 'prepress', 'production', 'qc', 'shipping', 'complete']
                  .map((s) => `<option value="${s}" ${state.params.stage === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select>`
              : `<input class="input" id="a-param" type="number" min="0" style="max-width:90px" value="${esc(state.params[t.param.key] ?? t.param.default)}">`}
          </div>` : ''}
          ${t?.timed ? '<div class="dim" style="font-size:11px;margin-top:6px">Time-based — checked every 5 minutes. Printavo gates these to its top tier.</div>' : ''}`
        $('#a-trig', root).onchange = (e) => { state.trigger = e.target.value; state.params = {}; drawTrigger() }
        const p = $('#a-param', root)
        if (p) p.oninput = p.onchange = (e) => { state.params[t.param.key] = t.param.key === 'stage' ? e.target.value : Number(e.target.value) }
      }

      const drawConds = () => {
        $('#ab-conds', root).innerHTML = `${state.conditions.map((c, i) => `<div class="row" style="gap:7px;margin-bottom:6px">
            <select class="input" data-ck="${i}" style="max-width:180px">${cfg.conditions.map((x) => `<option value="${x.key}" ${x.key === c.key ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
            <input class="input" data-cv="${i}" value="${esc(c.value ?? '')}" style="max-width:130px">
            <button class="del" data-rmc="${i}" aria-label="Remove condition ${i + 1}">&times;</button></div>`).join('')}
          <button class="btn ghost sm" id="add-cond">+ Add condition</button>
          ${state.conditions.length ? '' : '<span class="dim" style="font-size:11.5px;margin-left:8px">Always runs</span>'}`
        $('#add-cond', root).onclick = () => { state.conditions.push({ key: 'total_over', value: '' }); drawConds() }
        on($('#ab-conds', root), '[data-ck]', (_e, t) => { state.conditions[+t.dataset.ck].key = t.value }, 'change')
        on($('#ab-conds', root), '[data-cv]', (_e, t) => { state.conditions[+t.dataset.cv].value = t.value }, 'input')
        on($('#ab-conds', root), '[data-rmc]', (_e, t) => { state.conditions.splice(+t.dataset.rmc, 1); drawConds() })
      }

      const drawActions = () => {
        $('#ab-actions', root).innerHTML = `${state.actions.map((act, i) => {
          const def = cfg.actions.find((x) => x.key === act.key) || cfg.actions[0]
          return `<div class="ab-act">
            <div class="row" style="gap:7px">
              <select class="input" data-ak="${i}" style="max-width:210px">${cfg.actions.map((x) => `<option value="${x.key}" ${x.key === act.key ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
              <div class="sp"></div>
              ${state.actions.length > 1 ? `<button class="del" data-rma="${i}" aria-label="Remove action ${i + 1}">&times;</button>` : ''}
            </div>
            ${def.fields.map((f) => f.long
              ? `<textarea class="input" data-af="${i}:${f.key}" placeholder="${esc(f.label)}" style="margin-top:6px;min-height:70px">${esc(act.config?.[f.key] || '')}</textarea>`
              : `<input class="input" data-af="${i}:${f.key}" placeholder="${esc(f.label)}" value="${esc(act.config?.[f.key] || '')}" style="margin-top:6px">`).join('')}
          </div>`
        }).join('')}
        <button class="btn ghost sm" id="add-act">+ Add action</button>`
        $('#add-act', root).onclick = () => { state.actions.push({ key: 'notify.staff', config: {} }); drawActions() }
        on($('#ab-actions', root), '[data-ak]', (_e, t) => { const i = +t.dataset.ak; state.actions[i] = { key: t.value, config: {} }; drawActions() }, 'change')
        on($('#ab-actions', root), '[data-af]', (_e, t) => {
          const [i, k] = t.dataset.af.split(':')
          state.actions[+i].config = { ...state.actions[+i].config, [k]: t.value }
        }, 'input')
        on($('#ab-actions', root), '[data-rma]', (_e, t) => { state.actions.splice(+t.dataset.rma, 1); drawActions() })
      }

      drawTrigger(); drawConds(); drawActions()

      $('#a-save', root).onclick = async () => {
        state.name = $('#a-name', root).value.trim()
        if (!state.name) return toast('Give it a name', true)
        try {
          if (isNew) await api.post('/api/automations', state)
          else await api.put(`/api/automations/${a.id}`, state)
          closeModal()
          toast(isNew ? 'Automation created' : 'Automation saved')
          automationsView()
        } catch (e) { toast(e.message, true) }
      }
    },
  })
  return bg
}
