import { all } from './db.mjs'
import { validDate, shiftDate, planDates } from './production-timing.mjs'
export function productionCalendar({ start, end, department = '', mine = false, memberId = null }) {
  if (!validDate(start) || !validDate(end) || end < start || end > shiftDate(start, 62))
    throw Object.assign(new Error('Choose a calendar range of up to 63 days.'), { status: 400 })
  const jobs = all("SELECT j.id,j.job_number,j.title,j.stage,j.rush,j.due_date,p.timing FROM jobs j LEFT JOIN production_jobs p ON p.job_id=j.id WHERE j.status='active' ORDER BY j.id")
  const tasks = all("SELECT t.* FROM production_tasks t JOIN jobs j ON j.id=t.job_id WHERE j.status='active' ORDER BY t.position,t.id")
  const byJob = new Map()
  for (const task of tasks) { if (!byJob.has(task.job_id)) byJob.set(task.job_id, []); byJob.get(task.job_id).push(task) }
  const departments = [...new Set(tasks.map(t => t.department))].sort()
  const events = [], unscheduled = []
  for (const j of jobs) {
    const plan = planDates(JSON.parse(j.timing || '{}'), byJob.get(j.id) || [])
    const selected = plan.tasks.filter(t => (!department || t.department === department) && (!mine || (memberId != null && t.assigned_id === memberId)))
    if ((department || mine) && !selected.length) continue
    const base = { job_id: j.id, job_number: j.job_number, title: j.title, stage: j.stage, rush: j.rush }
    const add = (date, kind, label, task = null) => { if (validDate(date) && date >= start && date <= end) events.push({ ...base, date, kind, label, task_id: task?.id, department: task?.department, assigned_id: task?.assigned_id }) }
    add(j.due_date, 'delivery', 'Job due')
    add(plan.planned_production_date, 'production', 'Production')
    for (const t of selected) if (t.status === 'pending') add(t.planned_due_date, 'task', t.title, t)
    if (!validDate(j.due_date) && !plan.planned_production_date && !selected.some(t => t.planned_due_date && t.status === 'pending')) unscheduled.push(base)
  }
  events.sort((a,b) => a.date.localeCompare(b.date) || b.rush-a.rush || a.job_id-b.job_id)
  return { start, end, departments, events: events.slice(0,5000), event_count: events.length, truncated: events.length > 5000, unscheduled: unscheduled.slice(0,100), unscheduled_count: unscheduled.length }
}
