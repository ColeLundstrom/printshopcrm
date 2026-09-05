/** Explicit scope for the screenprinting model; never infer a method from artwork or task titles. */
import { sizeTotal } from './pricing.js'

export const isScreenPrintMethod = value => typeof value === 'string' && /^screen[\s-]*print(?:ing)?$/i.test(value.trim())
const parsed = (value, fallback) => { if (typeof value !== 'string') return value ?? fallback; try { return JSON.parse(value) } catch { return null } }
const named = value => typeof value === 'string' && value.trim() ? value.trim() : null

function lineMethod(line) {
  const labels = [named(line?.decoration), named(line?.matrix?.decoration) || named(line?.matrix?.name)].filter(Boolean)
  return { supported: labels.length > 0 && labels.every(isScreenPrintMethod), label: labels.join(' / ') || 'Unspecified decoration' }
}

/** Only sized garment lines carry production work; fees and discounts do not add a machine. */
export function unsupportedScreenPrintMethods(items) {
  return [...new Set((Array.isArray(items) ? items : []).filter(line => sizeTotal(line?.sizes) > 0)
    .map(lineMethod).filter(method => !method.supported).map(method => method.label))]
}

const unresolved = (code, reason) => ({ state: 'unresolved', code, reason })
const finished = reason => ({ state: 'finished', code: 'production_finished', reason })

/**
 * workflow_tasks is the complete task list, including done/skipped rows. A pending custom
 * production step after QC must not disappear; multiple production steps cannot be costed
 * from one undifferentiated job quantity. Legacy unenrolled jobs use their board stage.
 */
export function screenPrintJobScope(job = {}) {
  if (job.status && job.status !== 'active') return finished('This job is no longer active.')
  const tasks = parsed(job.workflow_tasks, [])
  const enrolled = job.workflow_enrolled === true || job.workflow_enrolled === 1 || (Array.isArray(tasks) && tasks.length > 0)
  if (enrolled) {
    if (!Array.isArray(tasks) || !tasks.length) return unresolved('workflow_unknown', 'The workflow has no production task to review.')
    if (tasks.some(task => !task || !['new', 'art_approval', 'prepress', 'production', 'qc', 'shipping'].includes(task.stage) || !['pending', 'done', 'skipped'].includes(task.status)))
      return unresolved('workflow_unknown', 'Review the workflow task stages and completion status.')
    const production = tasks.filter(task => task.stage === 'production')
    if (!production.length) return unresolved('workflow_unknown', 'The workflow has no production task to review.')
    if (production.every(task => task.status === 'done' || task.status === 'skipped')) return finished('The workflow records production as finished or skipped.')
    if (production.length > 1) return unresolved('multiple_production_steps', 'Multiple production steps need a manual remaining-time review.')
  } else {
    if (['qc', 'shipping', 'complete'].includes(job.stage)) return finished('This job is past production on the board.')
    if (!['new', 'art_approval', 'prepress', 'production'].includes(job.stage))
      return unresolved('stage_unknown', 'Set or review the current production stage.')
  }

  const items = parsed(job.est_items ?? job.items, [])
  const lines = parsed(job.line_sizes, [])
  if (!Array.isArray(items) || !Array.isArray(lines)) return unresolved('method_unknown', 'Review the saved garment-line method information.')
  const sized = items.filter(line => sizeTotal(line?.sizes) > 0)
  // line_sizes historically omits methods. Only its explicit method evidence can add a conflict.
  const explicitLines = lines.filter(line => sizeTotal(line?.sizes) > 0 && (named(line?.decoration) || named(line?.matrix?.decoration) || named(line?.matrix?.name)))
  const methods = [...sized, ...explicitLines].map(lineMethod)
  const jobMethod = named(job.decoration)
  if (jobMethod) methods.push({ supported: isScreenPrintMethod(jobMethod), label: jobMethod })
  if (!methods.length) return unresolved('method_unknown', 'Choose an explicit screenprinting method, or schedule this work manually.')
  const unsupported = [...new Set(methods.filter(method => !method.supported).map(method => method.label))]
  if (unsupported.length) return unresolved('method_unsupported', `Outside the screenprinting model: ${unsupported.join(', ')}. Review this work manually.`)
  return { state: 'modeled', code: 'screen_print', reason: 'Pending screenprinting work.' }
}
