import { pageRows, pageOptions } from './paging.mjs'
import { all, get, run, tx, now, JOB_STAGE_KEYS, logActivity, stampShipDate } from './db.mjs'
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}
const text = (v, max = 120) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max)
    fail(`Enter text between 1 and ${max} characters`)
  return v.trim()
}
export const templates = () =>
  all('SELECT * FROM production_templates ORDER BY archived,id').map((t) => ({
    ...t,
    steps: JSON.parse(t.steps)
  }))
export function validateSteps(steps, members = []) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 80) fail('Use 1–80 tasks')
  return steps.map((s) => {
    if (!s || !JOB_STAGE_KEYS.slice(0, -1).includes(s.stage)) fail('Choose a valid production stage')
    if (!['', 'receiving', 'approval'].includes(s.gate || '')) fail('Invalid task requirement')
    const assigned =
      s.assigned_id === null || s.assigned_id === undefined || s.assigned_id === '' ? null : s.assigned_id
    if (
      assigned !== null &&
      (!Number.isSafeInteger(assigned) || !members.some((m) => m.id === assigned && m.status === 'active'))
    )
      fail('Assign an active employee in this shop')
    return {
      title: text(s.title),
      department: text(s.department, 60),
      stage: s.stage,
      gate: s.gate || '',
      assigned_id: assigned
    }
  })
}
export function saveTemplate(id, b, members) {
  return tx(() => {
    const steps = validateSteps(b.steps, members),
      name = text(b.name, 60),
      match = b.match_text === undefined ? '' : String(b.match_text).trim().toLowerCase()
    if (match.length > 60) fail('Match text is too long')
    if (id) {
      const old = get('SELECT * FROM production_templates WHERE id=?', id)
      if (!old) fail('Workflow not found', 404)
      if (old.revision !== b.revision) fail('Workflow changed. Reload before saving.', 409)
      run(
        'UPDATE production_templates SET name=?,match_text=?,steps=?,archived=?,revision=revision+1 WHERE id=?',
        name,
        match,
        JSON.stringify(steps),
        b.archived === true ? 1 : 0,
        id
      )
    } else
      id = Number(
        run(
          'INSERT INTO production_templates(name,match_text,steps) VALUES(?,?,?)',
          name,
          match,
          JSON.stringify(steps)
        ).lastInsertRowid
      )
    return templates().find((t) => t.id === id)
  })
}
export function workflow(jobId) {
  return {
    revision: get('SELECT revision FROM production_jobs WHERE job_id=?', jobId)?.revision || 0,
    tasks: all('SELECT * FROM production_tasks WHERE job_id=? ORDER BY position,id', jobId),
    events: all('SELECT * FROM production_events WHERE job_id=? ORDER BY id DESC LIMIT 50', jobId)
  }
}
function event(jobId, taskId, actor, action, detail) {
  run(
    'INSERT INTO production_events(job_id,task_id,actor,action,detail) VALUES(?,?,?,?,?)',
    jobId,
    taskId,
    actor,
    action,
    detail
  )
  run('UPDATE production_jobs SET revision=revision+1 WHERE job_id=?', jobId)
}
function check(jobId, revision) {
  const j = get('SELECT * FROM jobs WHERE id=?', jobId)
  if (!j) fail('Job not found', 404)
  if (workflow(jobId).revision !== revision) fail('This job changed. Refresh before continuing.', 409)
  return j
}
export function applyWorkflow(jobId, b, actor) {
  return tx(() => {
    const j = check(jobId, b.revision)
    if (j.status !== 'active') fail('Reopen the job before adding tasks', 409)
    if (
      !Array.isArray(b.template_ids) ||
      !b.template_ids.length ||
      b.template_ids.length > 10 ||
      new Set(b.template_ids).size !== b.template_ids.length
    )
      fail('Choose 1–10 different workflows')
    if (workflow(jobId).tasks.length) fail('Tasks already exist. Edit this job’s tasks instead.', 409)
    const chosen = b.template_ids.map((id) => templates().find((t) => t.id === id && !t.archived))
    if (chosen.some((t) => !t)) fail('Workflow not found')
    // Shared receiving, approval, QC and shipping occur once; decoration-specific work stays separate.
    const seen = new Set(),
      steps = []
    for (const t of chosen)
      for (const s of t.steps) {
        const key = JSON.stringify([s.title, s.department, s.stage, s.gate, s.assigned_id])
        if (!seen.has(key)) {
          steps.push({ ...s, template_name: t.name })
          seen.add(key)
        }
      }
    if (chosen.length > 1)
      steps.sort((a, b) => JOB_STAGE_KEYS.indexOf(a.stage) - JOB_STAGE_KEYS.indexOf(b.stage))
    run('INSERT INTO production_jobs(job_id) VALUES(?)', jobId)
    steps.forEach((s, i) =>
      run(
        'INSERT INTO production_tasks(job_id,template_name,title,department,stage,gate,position,assigned_id) VALUES(?,?,?,?,?,?,?,?)',
        jobId,
        s.template_name,
        s.title,
        s.department,
        s.stage,
        s.gate,
        i,
        s.assigned_id
      )
    )
    event(jobId, null, actor, 'workflow.added', chosen.map((t) => t.name).join(' + '))
    return workflow(jobId)
  })
}
export function editTask(jobId, taskId, b, actor, members) {
  return tx(() => {
    const job = check(jobId, b.revision)
    if (job.status !== 'active') fail('Reopen a completed task before adding or editing tasks.', 409)
    const s = validateSteps([b], members)[0]
    const before = taskId
      ? get('SELECT * FROM production_tasks WHERE id=? AND job_id=?', taskId, jobId)
      : null
    if (taskId && !before) fail('Task not found', 404)
    if (before && before.status !== 'pending') fail('Only pending tasks can be edited. Reopen first.', 409)
    if (!Number.isSafeInteger(b.position) || b.position < 0 || b.position > 10000)
      fail('Order must be a whole number between 0 and 10000')
    if (!get('SELECT 1 FROM production_jobs WHERE job_id=?', jobId))
      run('INSERT INTO production_jobs(job_id) VALUES(?)', jobId)
    if (taskId)
      run(
        'UPDATE production_tasks SET title=?,department=?,stage=?,gate=?,position=?,assigned_id=?,updated_at=? WHERE id=?',
        s.title,
        s.department,
        s.stage,
        s.gate,
        b.position,
        s.assigned_id,
        now(),
        taskId
      )
    else
      taskId = Number(
        run(
          'INSERT INTO production_tasks(job_id,title,department,stage,gate,position,assigned_id) VALUES(?,?,?,?,?,?,?)',
          jobId,
          s.title,
          s.department,
          s.stage,
          s.gate,
          b.position,
          s.assigned_id
        ).lastInsertRowid
      )
    event(
      jobId,
      taskId,
      actor,
      before ? 'task.edited' : 'task.added',
      JSON.stringify({ before, after: s, position: b.position })
    )
    return workflow(jobId)
  })
}
export function taskBlock(job, t, rows, state = null) {
  if (job.status !== 'active') return 'Job is not active'
  if (
    rows.some(
      (x) => x.status === 'pending' && (x.position < t.position || (x.position === t.position && x.id < t.id))
    )
  )
    return 'Waiting for earlier tasks'
  if (
    job.invoice_id &&
    (state
      ? state.payment_review
      : get('SELECT payment_review FROM invoices WHERE id=?', job.invoice_id)?.payment_review)
  )
    return 'Payment review is holding this job'
  if (
    (t.gate === 'approval' || ['production', 'qc', 'shipping'].includes(t.stage)) &&
    job.approval_gated &&
    !job.art_approved_at
  )
    return 'Artwork approval required'
  if (t.gate === 'receiving') {
    const open = state
      ? state.orders?.shortage
      : get(
          `SELECT 1 FROM purchase_orders p JOIN po_lines l ON l.po_id=p.id WHERE p.job_id=? AND p.status NOT IN ('closed','cancelled') AND l.qty_received<l.qty_ordered LIMIT 1`,
          job.id
        )
    if (open) return 'Receive or resolve outstanding PO quantities first'
    if (!(state ? state.orders : get('SELECT 1 FROM purchase_orders WHERE job_id=?', job.id))) {
      const expected = JSON.parse(job.sizes || '{}'),
        counts = state
          ? state.counts
          : JSON.parse(get('SELECT counts FROM production_counts WHERE job_id=?', job.id)?.counts || '{}')
      if (
        !Object.values(expected).some((n) => Number(n) > 0) ||
        Object.entries(expected).some(([size, n]) => Number(n) > Number(counts[size] || 0))
      )
        return 'Record the received garment counts first'
    }
  }
  return ''
}
export function transitionTask(jobId, taskId, b, { name = 'Staff', id = null, manager = false } = {}) {
  return tx(() => {
    const job = check(jobId, b.revision),
      w = workflow(jobId),
      t = w.tasks.find((t) => t.id === taskId)
    if (!t) fail('Task not found', 404)
    if (!['complete', 'skip', 'reopen'].includes(b.action)) fail('Invalid task action')
    if (b.action !== 'complete' && !manager) fail('A manager must skip or reopen tasks', 403)
    if (!manager && t.assigned_id !== null && t.assigned_id !== id)
      fail('This task is assigned to another employee', 403)
    const note = typeof b.note === 'string' ? b.note.trim() : ''
    if (note.length > 1000) fail('Note is too long')
    if (b.action !== 'complete' && !note) fail('Add a reason for this change')
    if (b.action === 'reopen') {
      if (t.status === 'pending') fail('Task is already open', 409)
      if (
        w.tasks.some(
          (x) =>
            x.status === 'done' && (x.position > t.position || (x.position === t.position && x.id > t.id))
        )
      )
        fail('Reopen completed later tasks first', 409)
    } else {
      if (t.status !== 'pending') fail('Task has already changed', 409)
      if (b.action === 'complete') {
        const blocked = taskBlock(job, t, w.tasks)
        if (blocked) fail(blocked, 409)
      }
    }
    const status = b.action === 'reopen' ? 'pending' : b.action === 'skip' ? 'skipped' : 'done'
    run(
      'UPDATE production_tasks SET status=?,note=?,completed_by=?,completed_at=?,updated_at=? WHERE id=?',
      status,
      note,
      status === 'pending' ? null : name,
      status === 'pending' ? null : now(),
      now(),
      taskId
    )
    event(jobId, taskId, name, `task.${b.action}`, note || t.title)
    // Workflows are authoritative only for enrolled jobs. Never auto-send customer communication.
    const next = workflow(jobId).tasks.find((x) => x.status === 'pending'),
      stage = next?.stage || 'complete'
    run(
      'UPDATE jobs SET stage=?,status=?,updated_at=? WHERE id=?',
      stage,
      stage === 'complete' ? 'complete' : 'active',
      now(),
      jobId
    )
    if (stage === 'complete') stampShipDate(job, 'complete')
    logActivity('production', `${t.title}: ${status} — ${name}`, {
      job_id: jobId,
      contact_id: job.contact_id
    })
    return workflow(jobId)
  })
}
export function guardWorkflowStage(jobId, stage) {
  const w = workflow(jobId)
  if (!w.revision) return
  const next = w.tasks.find((t) => t.status === 'pending')
  if (stage !== (next?.stage || 'complete'))
    fail('Complete or edit the production tasks to move this job.', 409)
}

/** A single read per table, with the same gates used by task completion. */
export function productionQueue({ department = '', mine = false, memberId = null, ...options } = {}) {
  pageOptions(options)
  const jobs = all(
    "SELECT j.*,p.revision workflow_revision FROM jobs j JOIN production_jobs p ON p.job_id=j.id WHERE j.status='active' ORDER BY j.rush DESC,j.due_date IS NULL,j.due_date,j.id"
  )
  const tasks = new Map()
  for (const task of all(
    "SELECT t.* FROM production_tasks t JOIN jobs j ON j.id=t.job_id WHERE j.status='active' AND t.status='pending' ORDER BY t.job_id,t.position,t.id"
  )) {
    if (!tasks.has(task.job_id)) tasks.set(task.job_id, [])
    tasks.get(task.job_id).push(task)
  }
  const holds = new Map(
    all("SELECT id,payment_review FROM invoices WHERE payment_review IS NOT NULL AND payment_review<>''").map(
      (i) => [i.id, i.payment_review]
    )
  )
  const orders = new Map(
    all(
      "SELECT p.job_id,sum(CASE WHEN p.status NOT IN ('closed','cancelled') AND l.qty_received<l.qty_ordered THEN 1 ELSE 0 END) shortage FROM purchase_orders p JOIN jobs j ON j.id=p.job_id LEFT JOIN po_lines l ON l.po_id=p.id WHERE j.status='active' GROUP BY p.job_id"
    ).map((p) => [p.job_id, p])
  )
  const counts = new Map(
    all(
      "SELECT c.job_id,c.counts FROM production_counts c JOIN jobs j ON j.id=c.job_id WHERE j.status='active'"
    ).map((c) => [c.job_id, JSON.parse(c.counts)])
  )
  const rows = []
  for (const j of jobs) {
    const pending = tasks.get(j.id) || []
    const state = {
      payment_review: holds.get(j.invoice_id),
      orders: orders.get(j.id),
      counts: counts.get(j.id) || {}
    }
    for (const task of pending) {
      if ((department && task.department !== department) || (mine && task.assigned_id !== memberId)) continue
      rows.push({
        job_id: j.id,
        job_number: j.job_number,
        title: j.title,
        due_date: j.due_date,
        rush: j.rush,
        task,
        blocked: taskBlock(j, task, pending.length ? [pending[0]] : [], state),
        revision: j.workflow_revision
      })
    }
  }
  // Stable sorting keeps the shop's rush/date order within ready and waiting sections.
  rows.sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked))
  const ready = rows.filter((r) => !r.blocked).length
  return { ...pageRows(rows, options), ready, waiting: rows.length - ready }
}
