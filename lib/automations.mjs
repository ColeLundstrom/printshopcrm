import { guardWorkflowStage } from './production.mjs'
/**
 * Automation engine — GHL's best idea, made print-shop native and never metered.
 *
 * Printavo caps automations by plan (5/15/30) and charges $15 per extra 30; time-based
 * ones are Premium-only. Here they're unlimited on every plan, the triggers are shop
 * events rather than generic CRM ones, and every run is logged so a shop can see exactly
 * what fired and why — the thing that makes people trust automation instead of fear it.
 */
import { all, get, run, tx, now, round2, getSettings, shopFormat, logActivity, scheduleFor, templateValue, JOB_STAGE_KEYS, statusForStage, stampShipDate } from './db.mjs'

/* ---------- catalogue ---------- */

export const TRIGGERS = [
  { key: 'estimate.sent', label: 'Estimate is sent', entity: 'estimate' },
  { key: 'estimate.approved', label: 'Estimate is approved', entity: 'estimate' },
  { key: 'estimate.stale', label: 'Estimate has gone quiet', entity: 'estimate', timed: true, param: { key: 'days', label: 'Days with no answer', default: 3 } },
  { key: 'invoice.paid', label: 'Invoice is paid in full', entity: 'invoice' },
  { key: 'invoice.overdue', label: 'Invoice goes past due', entity: 'invoice', timed: true, param: { key: 'days', label: 'Days past due', default: 1 } },
  { key: 'art.sent', label: 'Proof is sent to customer', entity: 'job' },
  { key: 'art.approved', label: 'Proof is approved', entity: 'job' },
  { key: 'art.rejected', label: 'Customer requests changes', entity: 'job' },
  { key: 'art.waiting', label: 'Proof has sat unanswered', entity: 'job', timed: true, param: { key: 'days', label: 'Days waiting', default: 2 } },
  { key: 'job.stage', label: 'Job reaches a stage', entity: 'job', param: { key: 'stage', label: 'Stage', default: 'shipping', options: JOB_STAGE_KEYS } },
  { key: 'job.due_soon', label: 'Job is due soon', entity: 'job', timed: true, param: { key: 'days', label: 'Days before due', default: 2 } },
  { key: 'job.at_risk', label: 'Deadline slips past what was promised', entity: 'job', timed: true },
  { key: 'contact.created', label: 'New customer is added', entity: 'contact' },
  { key: 'opportunity.won', label: 'A deal is won', entity: 'opportunity' },
  { key: 'opportunity.lost', label: 'A deal is lost', entity: 'opportunity' },
  { key: 'conversation.received', label: 'Customer sends a message', entity: 'contact' },
]

export const ACTIONS = [
  { key: 'email.customer', label: 'Email the customer', fields: [{ key: 'subject', label: 'Subject' }, { key: 'body', label: 'Message', long: true }] },
  { key: 'sms.customer', label: 'Text the customer', fields: [{ key: 'body', label: 'Message', long: true }] },
  { key: 'notify.staff', label: 'Notify the shop', fields: [{ key: 'body', label: 'Message', long: true }] },
  { key: 'contact.tag', label: 'Tag the customer', fields: [{ key: 'tag', label: 'Tag' }] },
  { key: 'job.move', label: 'Move the job to a stage', fields: [{ key: 'stage', label: 'Stage', options: JOB_STAGE_KEYS }] },
  { key: 'job.flag_rush', label: 'Flag the job as rush', fields: [] },
  { key: 'note.log', label: 'Write a note on the timeline', fields: [{ key: 'body', label: 'Note' }] },
  // Send the event to any external service (Zapier / Make / the shop's own endpoint). This is the
  // integration escape hatch — one webhook turns every automation trigger into a Zapier feed.
  { key: 'webhook.post', label: 'Send a webhook (Zapier, etc.)', fields: [{ key: 'url', label: 'Webhook URL (https)' }] },
  // The step that turns a rule into a drip sequence: run what's before it, pause, then
  // continue the rest after the delay. This is the multi-step workflow GHL is known for.
  { key: 'wait', label: 'Wait, then continue', fields: [{ key: 'days', label: 'Days to wait' }] },
]

export const CONDITIONS = [
  { key: 'total_over', label: 'Order total is over', kind: 'number' },
  { key: 'total_under', label: 'Order total is under', kind: 'number' },
  { key: 'has_tag', label: 'Customer has tag', kind: 'text' },
  { key: 'is_rush', label: 'Job is a rush', kind: 'bool' },
  { key: 'decoration_is', label: 'Decoration is', kind: 'text' },
]

/* ---------- storage ---------- */

export function initAutomations(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS automations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    trigger TEXT NOT NULL,
    params TEXT DEFAULT '{}',
    conditions TEXT DEFAULT '[]',
    actions TEXT DEFAULT '[]',
    run_count INTEGER DEFAULT 0,
    last_run_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS automation_runs (
    id INTEGER PRIMARY KEY,
    automation_id INTEGER REFERENCES automations(id) ON DELETE CASCADE,
    automation_name TEXT,
    trigger TEXT,
    entity_type TEXT,
    entity_id INTEGER,
    entity_label TEXT,
    status TEXT,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_runs_auto ON automation_runs(automation_id);
  CREATE INDEX IF NOT EXISTS idx_runs_dedup ON automation_runs(trigger, entity_id, automation_id, status);
  -- The automations-this-week count on /api/dashboard and /api/automations. automation_runs grows
  -- by a row per rule per fire and is never pruned (it cannot be: entity_id is also the permanent
  -- re-fire latch, so deleting history would re-nag customers about old records). Covering, so the
  -- count reads the index and never touches the table.
  CREATE INDEX IF NOT EXISTS idx_runs_status_created ON automation_runs(status, created_at);

  CREATE TABLE IF NOT EXISTS automation_pending (
    id INTEGER PRIMARY KEY,
    automation_id INTEGER,
    automation_name TEXT,
    trigger TEXT,
    ctx TEXT,              -- serialized trigger context, so the sequence can resume
    actions TEXT,          -- snapshot of the remaining steps (edits mid-flight don't corrupt it)
    next_index INTEGER,    -- where to resume in that snapshot
    due_at DATETIME,       -- when the wait expires
    label TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_pending_due ON automation_pending(due_at);
  `)
  // Additive, idempotent — an existing shop keeps its queue. NULL status = still waiting; the
  // parked states ('orphaned', 'failed') are what a sequence becomes instead of being deleted.
  for (const [col, decl] of [['status', 'TEXT'], ['attempts', 'INTEGER DEFAULT 0'], ['note', 'TEXT']]) {
    const has = db.prepare(`SELECT 1 AS x FROM pragma_table_info('automation_pending') WHERE name = ?`).get(col)
    if (!has) db.exec(`ALTER TABLE automation_pending ADD COLUMN ${col} ${decl}`)
  }
  // Where a FAILED run stopped. automation_pending has had this column since it was written; the
  // run log, which is the other half of the same engine, only ever had the sentence "1 of 3
  // step(s) ran" in `detail` — a string nothing reads back. So Try again re-entered at step 0 and
  // re-sent the customer email step 1 had already sent. Same additive, idempotent shape.
  {
    const has = db.prepare(`SELECT 1 AS x FROM pragma_table_info('automation_runs') WHERE name = ?`).get('next_index')
    if (!has) db.exec('ALTER TABLE automation_runs ADD COLUMN next_index INTEGER')
  }

  // Both of this engine's identity checks key on a rowid, and SQLite REUSES rowids: `id INTEGER
  // PRIMARY KEY` with no AUTOINCREMENT hands out max(rowid)+1, so deleting the newest quote gives
  // its id to the next one created. Two consequences, both silent:
  //   automation_runs.entity_id is a permanent latch (already() blocks any re-fire for the same
  //   rule+entity, deliberately, so nobody is nagged twice) — the inheriting record walks into a
  //   latch set for a record that no longer exists and is NEVER chased. A live $4,200 quote sits
  //   nine days quiet with the follow-up the shop switched on, and nothing goes out.
  //   automation_pending's resume guard asks "does this record still exist?" as a SELECT by id,
  //   which a reused id passes — so a paused drip wakes up and runs about the DELETED record.
  // A trigger is the foreign key these columns cannot declare. The run row is history the shop
  // reads on the Automations screen, so it stays, label and all; only the latch is released.
  // This is the hazard lib/db.mjs:391-403 already documents and fixes for art_versions.
  for (const [type, table] of [['estimate', 'estimates'], ['invoice', 'invoices'], ['job', 'jobs'], ['contact', 'contacts']]) {
    if (!db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)) continue
    // The sweep is guarded on the trigger's own absence rather than left to run every boot: once
    // the trigger is in place it keeps the column clean, and a shop with years of run history
    // should not pay for a full scan of it on every process start.
    const swept = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(`trg_runs_${table}_delete`)
    if (!swept) {
      db.exec(`UPDATE automation_runs SET entity_id = NULL
        WHERE entity_type = '${type}' AND entity_id IS NOT NULL AND entity_id NOT IN (SELECT id FROM ${table})`)
    }
    // json_valid() guards the trigger: a ctx that is somehow not JSON must not make DELETE throw,
    // which would leave the shop unable to delete the record at all.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_runs_${table}_delete AFTER DELETE ON ${table}
        BEGIN UPDATE automation_runs SET entity_id = NULL
                WHERE entity_type = '${type}' AND entity_id = OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS trg_pending_${table}_delete AFTER DELETE ON ${table}
        BEGIN UPDATE automation_pending
                 SET status = 'orphaned', note = 'the record this sequence was about was deleted'
                WHERE status IS NULL AND json_valid(ctx)
                  AND json_extract(ctx, '$.${type}.id') = OLD.id; END;
    `)
  }

  // The same reused-rowid hazard as the loop above, on the RULE pointer rather than the entity
  // pointers. `automations.id` is a bare INTEGER PRIMARY KEY with no AUTOINCREMENT, so deleting
  // the newest rule hands its rowid straight to the next rule the shop builds. The resume guard
  // asks `SELECT enabled FROM automations WHERE id = ?`, finds that live NEW rule, and runs the
  // DELETED rule's snapshotted steps at the customer — the review-ask email the owner deleted the
  // rule to stop, three days later, logged under the deleted rule's name against the new rule's
  // id. automation_pending.automation_id was the one pointer in this block with no foreign key
  // and no trigger; its sibling automation_runs.automation_id has a real ON DELETE CASCADE.
  //
  // A trigger rather than a declared FK because CASCADE would be wrong here: the design PARKS
  // work it will not do rather than dropping it, so the shop can see on the Automations screen
  // what was abandoned. That is what the resume guard's own comment already promises.
  const sweptRules = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_pending_automation_delete'`).get()
  if (!sweptRules) {
    db.exec(`UPDATE automation_pending SET status = 'orphaned', note = 'the rule was deleted while this sequence was waiting'
              WHERE status IS NULL AND automation_id IS NOT NULL AND automation_id NOT IN (SELECT id FROM automations)`)
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_pending_automation_delete AFTER DELETE ON automations
      BEGIN UPDATE automation_pending
               SET status = 'orphaned', note = 'the rule was deleted while this sequence was waiting'
             WHERE status IS NULL AND automation_id = OLD.id; END;
  `)
}

const parse = (s, f) => { try { return JSON.parse(s) } catch { return f } }
export const listAutomations = () => all('SELECT * FROM automations ORDER BY id')
  .map((a) => ({ ...a, params: parse(a.params, {}), conditions: parse(a.conditions, []), actions: parse(a.actions, []) }))

/* ---------- evaluation ---------- */

function conditionsPass(conds, ctx) {
  for (const c of conds || []) {
    const v = c.value
    switch (c.key) {
      case 'total_over': if (!(Number(ctx.total || 0) > Number(v))) return false; break
      case 'total_under': if (!(Number(ctx.total || 0) < Number(v))) return false; break
      case 'has_tag': if (!String(ctx.contact?.tags || '').split(',').map((s) => s.trim()).includes(String(v).trim())) return false; break
      /* `kind: 'bool'` has been declared on this condition since it was written and read nowhere:
       * the builder renders a plain text box, so the value is whatever a manager types. The old
       * expression demanded the exact lowercase string "true" and INVERTED on everything else —
       * including the empty string a newly added condition is born with. So the rule every shop
       * builds ("job reaches production AND job is a rush → text the customer") fired on every
       * standard job and never on a rush one, which is the worst possible way to be wrong.
       * Read it the way every other truthy value in this codebase is read, and treat "not set"
       * as the affirmative the LABEL states. */
      case 'is_rush': {
        const want = ['', 'true', '1', 'yes', 'on', 'y'].includes(String(v ?? '').trim().toLowerCase())
        if (!!ctx.job?.rush !== want) return false
        break
      }
      case 'decoration_is': if (String(ctx.job?.decoration || '').toLowerCase() !== String(v).toLowerCase()) return false; break
      default: break
    }
  }
  return true
}

/** {{token}} fill from the trigger's context. Same token vocabulary as email templates. */
function fill(text, ctx) {
  const s = getSettings()
  const vars = {
    first_name: String(ctx.contact?.name || '').split(' ')[0],
    contact_name: ctx.contact?.name || '',
    shop_name: s.shop_name,
    estimate_number: ctx.estimate?.estimate_number || '',
    invoice_number: ctx.invoice?.invoice_number || '',
    job_number: ctx.job?.job_number || '',
    job_title: ctx.job?.title || '',
    due_date: ctx.job?.due_date || ctx.invoice?.due_date || '',
    total: ctx.total != null ? shopFormat().money(ctx.total) : '',   // {{total}} in a customer email, in the shop's currency
    version: ctx.version ?? '',
    days: ctx.days ?? '',
    stage: String(ctx.job?.stage || '').replace('_', ' '),
  }
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (_, k) => templateValue(k, vars, s))
}

/**
 * Run one action. Deps are injected (rather than imported) so the engine stays testable
 * and so the outbox/SMS side-effects live in exactly one place: server.mjs.
 */
function runAction(action, ctx, deps) {
  const cfg = action.config || {}
  switch (action.key) {
    case 'email.customer': {
      if (!ctx.contact?.email) return 'skipped — customer has no email'
      deps.queueEmail({ contact: ctx.contact, invoice_id:ctx.invoice?.id, kind: 'automation', subject: fill(cfg.subject, ctx), template: cfg.body, vars: ctxVars(ctx) })
      return `emailed ${ctx.contact.email}`
    }
    case 'sms.customer': {
      if (!ctx.contact?.phone) return 'skipped — customer has no phone'
      deps.queueSms({ contact: ctx.contact, invoice_id:ctx.invoice?.id, body: fill(cfg.body, ctx) })
      return `texted ${ctx.contact.phone}`
    }
    case 'notify.staff':
      logActivity('note', `${fill(cfg.body, ctx)}`, { contact_id: ctx.contact?.id ?? null, job_id: ctx.job?.id ?? null })
      return 'notified the shop'
    case 'contact.tag': {
      if (!ctx.contact?.id) return 'skipped — no customer'
      const tags = String(ctx.contact.tags || '').split(',').map((s) => s.trim()).filter(Boolean)
      const tag = String(cfg.tag || '').trim()
      if (!tag || tags.includes(tag)) return `already tagged ${tag}`
      tags.push(tag)
      run('UPDATE contacts SET tags = ?, updated_at = ? WHERE id = ?', tags.join(','), now(), ctx.contact.id)
      return `tagged ${tag}`
    }
    case 'job.move': {
      if (!ctx.job?.id) return 'skipped — no job'
      try { guardWorkflowStage(ctx.job.id,cfg.stage) } catch(e) { return `skipped — ${e.message}` }
      /* The stage came out of a free-text box and went straight into the column the whole board
       * is keyed on. A stage no column matches — `Production` for `production` — is a job that
       * disappears from the Job Board while the All chip still counts it, Floor Mode prints
       * "✓ Complete", and the job page's Stage select silently displays New. Refuse it here, and
       * SAY so in the run log, so a rule stored before this shipped degrades to a visible skip a
       * shop can act on instead of quietly corrupting a job. */
      if (!JOB_STAGE_KEYS.includes(cfg.stage)) return `skipped — "${String(cfg.stage ?? '').slice(0, 40)}" is not a stage`
      /* status, not just stage. This was the one stage-writer of five that never paired them, and
       * the board reads `WHERE j.status = 'active'`. A rule moving a job to complete left it
       * sitting in the Complete column for ever — still counted on the floor, still booking press
       * minutes in Capacity — and a rule moving one back out of complete left it invisible. */
      run('UPDATE jobs SET stage = ?, status = ?, updated_at = ? WHERE id = ?',
        cfg.stage, statusForStage(cfg.stage), now(), ctx.job.id)
      /* …and ship_date, which is the third thing every stage-writer owes. This was the one writer
       * of five that paired stage with status and still forgot it, so an automation that moves a
       * job to shipping printed a packing slip dated the day the job was BOOKED — measured at 72
       * days stale. Nothing in the product can correct that field from any screen. */
      stampShipDate(ctx.job, cfg.stage)
      logActivity('stage', `${ctx.job.job_number} moved to ${String(cfg.stage).replace('_', ' ')} by automation`, { contact_id: ctx.contact?.id, job_id: ctx.job.id })
      return `moved to ${cfg.stage}`
    }
    case 'job.flag_rush':
      if (!ctx.job?.id) return 'skipped — no job'
      try { guardWorkflowStage(ctx.job.id,cfg.stage) } catch(e) { return `skipped — ${e.message}` }
      run('UPDATE jobs SET rush = 1, updated_at = ? WHERE id = ?', now(), ctx.job.id)
      return 'flagged rush'
    case 'note.log':
      logActivity('note', fill(cfg.body, ctx), { contact_id: ctx.contact?.id ?? null, job_id: ctx.job?.id ?? null })
      return 'note written'
    case 'webhook.post': {
      const url = String(cfg.url || '').trim()
      if (!url) return 'skipped — no webhook URL'
      if (!deps.fireWebhook) return 'skipped — webhooks unavailable'
      // Build the payload from the same variables the templates use, plus the raw trigger/entity.
      const payload = { trigger: ctx._trigger || null, at: now(), entity: ctx._entityType || null,
        entity_id: ctx._entityId ?? null, data: ctxVars(ctx) }
      deps.fireWebhook(url, payload)   // fire-and-forget; SSRF-guarded + logged in server.mjs
      let host = url; try { host = new URL(url).host } catch { /* keep raw */ }
      // "queued", not "sent". The call above is deliberately detached, so at this point nothing
      // has been attempted — and this string is written straight into automation_runs.detail with
      // status 'ran', which the screen draws with no pill and no Try again. The delivery's real
      // outcome lands on the customer's timeline through fireWebhook.
      return `webhook queued to ${host}`
    }
    default:
      return `unknown action ${action.key}`
  }
}

const ctxVars = (ctx) => ({
  first_name: String(ctx.contact?.name || '').split(' ')[0],
  estimate_number: ctx.estimate?.estimate_number || '',
  invoice_number: ctx.invoice?.invoice_number || '',
  job_number: ctx.job?.job_number || '',
  job_title: ctx.job?.title || '',
  version: ctx.version ?? '',
  days: ctx.days ?? '',
  due_date: ctx.job?.due_date || ctx.invoice?.due_date || '',
  total: ctx.total != null ? shopFormat().money(ctx.total) : '',
})

const ctxLabel = (ctx) => ctx.estimate?.estimate_number || ctx.invoice?.invoice_number || ctx.job?.job_number || ctx.opportunity?.title || ctx.contact?.name || ''
const daysFromNow = (days) => new Date(Date.now() + Math.max(0, Number(days) || 0) * 864e5).toISOString().replace('T', ' ').slice(0, 19)

/**
 * Run a list of actions from a start index. On hitting a `wait`, everything after it is
 * snapshotted into automation_pending with a due time and execution stops — the tick loop
 * resumes it later. That split is what makes a rule a multi-step drip sequence.
 */
function executeActions(a, actions, ctx, deps, startIdx = 0, done = [], onStep = null) {
  const results = done
  for (let i = startIdx; i < (actions || []).length; i++) {
    const act = actions[i]
    if (act.key === 'wait') {
      const days = Math.max(0, Number(act.config?.days) || 1)
      run(`INSERT INTO automation_pending (automation_id, automation_name, trigger, ctx, actions, next_index, due_at, label, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        a.id, a.name, a.trigger, JSON.stringify(ctx), JSON.stringify(actions), i + 1, daysFromNow(days), ctxLabel(ctx), now())
      results.push(`wait: paused ${days}d, ${actions.length - i - 1} step(s) queued`)
      return { results, paused: true }
    }
    results.push(`${act.key}: ${runAction(act, ctx, deps)}`)
    // AFTER the action, never before: onStep records the index to resume AT, so a step that
    // throws leaves the mark on itself and a retry re-attempts exactly that step and no earlier
    // one. This is the only progress signal either caller has — `done.length` cannot be used,
    // because a `wait` pushes a result too.
    if (onStep) onStep(i + 1)
  }
  return { results, paused: false }
}

/**
 * Fire a trigger. Never throws into the caller — an automation blowing up must not take
 * down the estimate that was being approved.
 */
/** Execute ONE automation against a context. Isolated so the event path and the timed tick share
 *  exactly one code path (and one dedupe/logging story) instead of the tick fanning out to every
 *  same-trigger rule at once. */
function invoiceContextIssue(ctx,trigger) {
  if(!ctx.invoice?.id)return null
  const current=get('SELECT * FROM invoices WHERE id=?',ctx.invoice.id)
  if(current?.payment_review)return 'payment changed; review this invoice before resuming this sequence'
  if(current && (current.credit_base || get('SELECT 1 FROM payment_reversals WHERE invoice_id=?',current.id))) {
    if(current.status==='void' || (trigger==='invoice.paid' && current.status!=='paid') || (trigger==='invoice.overdue' && current.amount_due-current.amount_paid<=0.005))return 'invoice balance changed; this payment message no longer applies'
    ctx.invoice=current
    ctx.total=trigger==='invoice.overdue'?round2(current.amount_due-current.amount_paid):current.amount_due
  }
  return null
}
export function runAutomation(a, trigger, ctx, deps, startIdx = 0) {
  const issue=invoiceContextIssue(ctx,trigger)
  if(issue) {logRun(a,trigger,ctx,ctxLabel(ctx),'skipped',issue);return}
  const label = ctxLabel(ctx)
  // Stamp the trigger + anchor entity so a webhook action can report what fired it.
  ctx._trigger = trigger
  ctx._entityType = ctx.estimate ? 'estimate' : ctx.invoice ? 'invoice' : ctx.job ? 'job' : ctx.contact ? 'contact' : null
  ctx._entityId = ctx.estimate?.id ?? ctx.invoice?.id ?? ctx.job?.id ?? ctx.contact?.id ?? null
  if (!conditionsPass(a.conditions, ctx)) { logRun(a, trigger, ctx, label, 'skipped', 'conditions not met'); return }
  // RESERVE before side effects. executeActions sends real customer email/SMS; if the process
  // crashed between the send and the run-log write, the next tick re-fired and re-sent — breaking
  // the at-most-once guarantee. Writing the dedupe row first means a crash mid-send can never cause
  // a duplicate; the cost is that a transient failure is not retried, which is the safe default
  // when the side effect is an irreversible message to a customer.
  const runId = logRun(a, trigger, ctx, label, 'ran', '')
  run('UPDATE automations SET run_count = run_count + 1, last_run_at = ? WHERE id = ?', now(), a.id)
  // The reserved row says 'ran' before anything has run. If an action throws, the detail UPDATE
  // below is skipped too, so the owner was left with a clean green success carrying an EMPTY
  // detail — for a rule that tagged the customer, died on step 2, and never sent the email on
  // step 4. The only record of the failure was one console line on a box they have no shell on.
  // `done` accumulates in place so the steps that DID run survive the throw and can be named.
  const done = []
  // The shop can edit the rule between the failure and the Try again, and a stored index that is
  // no longer a step of this rule means nothing. Resuming AT it would run no steps at all and log
  // that green — a red row turning green having done nothing is worse than doing it twice. An
  // index outside the current rule starts over; inside it, it is honoured exactly.
  const want = Math.max(0, Number(startIdx) || 0)
  const from = want >= (a.actions || []).length ? 0 : want
  let nextIdx = from
  try {
    const { results } = executeActions(a, a.actions, ctx, deps, from, done, (n) => { nextIdx = n })
    /**
     * A run in which nothing actually happened is not a run.
     *
     * runAction returns a STRING for a send AND for a skip, and logRun had no third status — so
     * a chase whose only customer-facing step answered "skipped — customer has no email" was
     * logged 'ran'. already() counts 'ran' as fired, permanently and by design, so that record
     * was latched out of the rule for ever. Driven: a walk-in with a phone and no email on a
     * $4,200 quote twenty days old. The shop adds the email — the obvious, correct thing — and
     * three more ticks fire nothing, POST /api/automations/runs/:id/retry answers 409 not_failed
     * because the row is not an error, and the screen draws Try again only on errors. Zero mail
     * ever leaves. The only release was sqlite3.
     *
     * `results.length &&` matters: a rule with no actions at all must stay latched, or it
     * re-evaluates on every tick for ever and fills the run log with nothing.
     */
    const list = results || []
    const allSkipped = list.length > 0 && list.every((r) => /: skipped\b/.test(String(r)))
    run('UPDATE automation_runs SET status = ?, detail = ?, next_index = ? WHERE id = ?',
      allSkipped ? 'skipped' : 'ran', list.join(' · '), allSkipped ? 0 : null, runId)
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200)
    console.error('automation action failed:', a.name, msg)
    // 'error' has always been checked by the dedupe latch and rendered as a red pill by the
    // Automations screen. Nothing in the codebase ever wrote it.
    //
    // next_index is the step that threw. Without it, the Try again button on this row re-entered
    // the rule at 0 — measured: a three-step chase whose step 2 failed mailed sam@example.com the
    // same quote follow-up a second time, fourteen seconds after the first, and the customer's
    // conversation thread carried both. The resume index existed only as prose in `detail`.
    run('UPDATE automation_runs SET status = ?, detail = ?, next_index = ? WHERE id = ?', 'error',
      `${done.length} of ${(a.actions || []).length} step(s) ran${done.length ? ` · ${done.join(' · ')}` : ''} · then failed: ${msg}`,
      nextIdx, runId)
  }
}

/**
 * A trigger that takes a parameter but has none stored.
 *
 * `job.stage` fired when `a.params.stage` was falsy, on the reading that "no stage set" meant
 * "unfiltered". It does not mean that — a rule that names no stage is a rule nobody finished
 * writing, and treating it as "matches everything" turned one job crossing the board into six
 * customer emails, on every job in the shop. The builder made it the DEFAULT shape: the stage
 * dropdown showed whatever the browser selected first while `params` went to the server empty.
 *
 * Never fires. The rule is reported as needing setup instead, so it is fixable from the screen
 * it was written on rather than silently doing nothing.
 *
 * Timed triggers are deliberately NOT covered. Their parameter is a THRESHOLD ("3 days quiet"),
 * not a selector, and the tick already falls back to the documented default when it is absent —
 * so a missing `days` narrows nothing and matches nothing extra. Calling those "needs setup"
 * would flag a rule that is dunning correctly today, and skipping them would stop it.
 */
export const needsSetup = (a) => {
  const t = TRIGGERS.find((x) => x.key === a.trigger)
  if (!t?.param || t.timed) return false
  const v = (typeof a.params === 'string' ? (() => { try { return JSON.parse(a.params) } catch { return {} } })() : a.params) || {}
  return !String(v[t.param.key] ?? '').trim()
}

export function fire(trigger, ctx, deps) {
  for (const a of listAutomations()) {
    if (!a.enabled || a.trigger !== trigger) continue
    if (needsSetup(a)) continue
    // Parameterised triggers only fire for their configured value (e.g. stage = shipping).
    if (a.trigger === 'job.stage' && ctx.job?.stage !== a.params.stage) continue
    // Timed triggers carry a `days` threshold — only the rule whose threshold matches the firing
    // context should run, so a "day 3" nudge never fires the "day 10 final notice" too.
    if (ctx.days != null && a.params?.days != null && Number(a.params.days) !== Number(ctx.days)) continue
    runAutomation(a, trigger, ctx, deps)
  }
}

function logRun(a, trigger, ctx, label, status, detail) {
  return Number(run(`INSERT INTO automation_runs (automation_id, automation_name, trigger, entity_type, entity_id, entity_label, status, detail, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    a.id, a.name, trigger,
    ctx.estimate ? 'estimate' : ctx.invoice ? 'invoice' : ctx.job ? 'job' : 'contact',
    ctx.estimate?.id ?? ctx.invoice?.id ?? ctx.job?.id ?? ctx.contact?.id ?? null,
    label, status, detail, now()).lastInsertRowid)
}

/* ---------- time-based triggers ---------- */

/**
 * The tick. Printavo gates time-based automations to its top tier; this is a loop.
 *
 * Every timed trigger is idempotent by construction: it checks the run log before firing
 * so a shop doesn't get nagged once a minute for the same stale quote.
 */
export function tick(deps) {
  const fired = []
  // Per-shop per-tick send budget. A shop that CSV-imports years of sent estimates / overdue
  // invoices would otherwise fire every matching automation in a single pass — thousands of real
  // customer emails at once. already() records each fire, so the backlog still clears over the next
  // ticks; this just caps how many go out per 5-minute pass.
  const TICK_BUDGET = Number(process.env.PSC_TICK_BUDGET) || 100
  const overBudget = () => fired.length >= TICK_BUDGET
  // A timed trigger must fire AT MOST ONCE per (automation, entity) — permanently. The old 20h
  // window let it re-nag the same customer every day forever, because the entity stays in the
  // matching state and firing changes nothing on it. Any prior 'ran' row for this rule+entity blocks.
  // 'ran' OR 'error' both block a re-fire: a rule that failed AFTER sending must not retry every
  // 5 minutes and re-send to the customer, so a failed run is not retried on its own.
  // It is not a dead end either — the comment here used to claim "a shop can re-enable the rule
  // to try again", which was simply false: re-enabling writes automations.enabled and this reads
  // automation_runs. The real escape is POST /api/automations/runs/:id/retry, which stamps the
  // row 'retry' (releasing this latch, keeping the history) behind a button on the run log.
  const already = (trigger, id, automationId) => get(
    `SELECT 1 AS x FROM automation_runs WHERE trigger = ? AND entity_id = ? AND automation_id = ? AND status IN ('ran','error')`,
    trigger, id, automationId)

  /**
   * Where a released run stopped.
   *
   * already() is the only thing standing between a timed rule and re-nagging the same customer,
   * and the ONE door through it is the Try again button stamping 'retry'. So every entity that
   * reaches runAutomation from a timed loop with the latch released is, by construction, a
   * resumed run — and it must not re-do the steps that already succeeded. Reads the newest
   * released row for this rule + entity; 0 for anything else, which is every ordinary first fire.
   */
  const resumeAt = (trigger, id, automationId) => Number(get(
    `SELECT next_index FROM automation_runs WHERE trigger = ? AND entity_id = ? AND automation_id = ?
       AND status = 'retry' ORDER BY id DESC LIMIT 1`, trigger, id, automationId)?.next_index) || 0

  /**
   * Resume drip sequences whose wait has expired.
   *
   * This used to DELETE the pending row before checking whether the rule was still enabled, so
   * an owner who switched a rule off for an hour — to edit the copy, to pause over a holiday,
   * because a customer complained — permanently destroyed step 2 and step 3 of every sequence
   * that came due in that window. Turning it back on brought nothing back, nothing was logged,
   * and the original run row went on advertising "2 step(s) queued" for a queue that no longer
   * existed. The off switch was a delete button.
   *
   * Now the row is CLAIMED (due_at pushed out so an overlapping tick can't double-run it) and
   * only removed once the step has actually run. A paused rule leaves its queue exactly where it
   * is; re-enabling resumes it. Work we will not do is parked with a reason, never dropped.
   */
  const exists = (type, id) => id == null || !!get(`SELECT 1 AS x FROM ${type} WHERE id = ?`, id)
  const park = (id, status, note) => run('UPDATE automation_pending SET status = ?, note = ? WHERE id = ?', status, String(note || '').slice(0, 200), id)
  /* Bounded by the same send budget every loop below it obeys, and by a LIMIT.
   *
   * TICK_BUDGET exists — its own comment says so — to stop "thousands of real customer emails at
   * once". This loop checked neither it nor any LIMIT, and there are two ordinary ways to fill the
   * queue: an owner switches a multi-step rule off over the holidays (the code DELIBERATELY leaves
   * the queue intact and resumes it, which is right) and then switches it back on, so every row's
   * due_at is in the past at once; or the process is down for a day. Every queued step of every
   * sequence for every customer then went out in a single five-minute pass, from a screen whose
   * only affordance was an on/off toggle.
   *
   * It also starved the loops below it: each resume does fired.push(), so a backlog over
   * TICK_BUDGET made overBudget() true immediately and the timed triggers — stale quotes, overdue
   * dunning — silently did nothing for that shop on that tick. The claim below pushes due_at out
   * five minutes, so anything skipped here is picked up on the next pass with nothing lost. */
  for (const p of all(`SELECT * FROM automation_pending WHERE due_at <= datetime('now') AND status IS NULL ORDER BY id LIMIT ?`, TICK_BUDGET)) {
    if (overBudget()) break
    // Claim first: a step that throws, or a process that dies mid-send, must not be retried in a
    // hot loop. Five minutes is one tick.
    run("UPDATE automation_pending SET due_at = datetime('now','+5 minutes') WHERE id = ?", p.id)
    try {
      const live = get('SELECT enabled FROM automations WHERE id = ?', p.automation_id)
      // Deleted rule: the sequence can never run. Park it so the shop can SEE what was dropped.
      if (!live) { park(p.id, 'orphaned', 'the rule was deleted while this sequence was waiting'); continue }
      // Disabled rule: paused, not destroyed. The claim above retries it in five minutes, so
      // switching the rule back on picks the sequence up where it stopped.
      if (!live.enabled) continue
      const ctx = JSON.parse(p.ctx)
      const actions = JSON.parse(p.actions)
      const issue=invoiceContextIssue(ctx,p.trigger)
      if(issue) {park(p.id, 'payment_review', issue);continue}
      // The anchor record (customer / estimate / invoice / job) may have been deleted mid-wait —
      // don't message about a record that no longer exists, but say so rather than vanishing.
      if (!exists('contacts', ctx.contact?.id) || !exists('estimates', ctx.estimate?.id)
        || !exists('invoices', ctx.invoice?.id) || !exists('jobs', ctx.job?.id)) {
        park(p.id, 'orphaned', 'the record this sequence was about was deleted'); continue
      }
      const attempts = (Number(p.attempts) || 0) + 1
      run('UPDATE automation_pending SET attempts = ? WHERE id = ?', attempts, p.id)
      const a = { id: p.automation_id, name: p.automation_name, trigger: p.trigger }
      // Persist progress AS IT GOES. The only writer of next_index used to be the `wait` branch of
      // executeActions, so a sequence whose step 3 failed sat at the index of step 3's PREDECESSOR
      // through the whole three-attempt ladder — and the ladder re-ran step 2. Measured: three
      // identical "DRIP followup" emails to one customer across three ticks, and a fourth when the
      // owner pressed the Resume button the parked row offers, which also resets attempts to 0 and
      // so buys three more.
      const { results } = executeActions(a, actions, ctx, deps, p.next_index, [],
        (nextIdx) => run('UPDATE automation_pending SET next_index = ? WHERE id = ?', nextIdx, p.id))
      // Done — and executeActions has already queued a NEW row if another wait followed.
      run('DELETE FROM automation_pending WHERE id = ?', p.id)
      logRun(a, p.trigger, ctx, p.label, 'ran', `resumed · ${results.join(' · ')}`)
      fired.push(`resume ${p.automation_name}`)
    } catch (e) {
      // Bounded: three goes, then park with the reason instead of retrying forever.
      //
      // The counter has to be WRITTEN here, not only at the park threshold. It used to be
      // incremented inside the try, AFTER JSON.parse(p.ctx), JSON.parse(p.actions) and the four
      // exists() probes — so any throw upstream of that line (a ctx column that will not parse, a
      // SQLITE_BUSY on a probe, a table missing after a partial migration) left attempts at its
      // stored value for ever. attempts was never 3, park was never called, and the claim above
      // re-armed the row: one line on stdout every five minutes, for ever, while the Automations
      // screen showed a live "in a sequence" row with no Resume button, because Resume is only
      // offered on a STOPPED one. The only exit was Cancel, which destroys the sequence.
      const attempts = (Number(p.attempts) || 0) + 1
      run('UPDATE automation_pending SET attempts = ? WHERE id = ?', attempts, p.id)
      console.error('pending resume failed:', e.message)
      // `fired` is the tick's whole report — the shop's only signal that anything happened. It was
      // pushed to on success only, so three failing attempts in a row answered {"fired":[]} and
      // the first thing anyone knew about it was the customer.
      fired.push(`resume FAILED ${p.automation_name}${p.label ? ` ${p.label}` : ''}`)
      if (attempts >= 3) park(p.id, 'failed', e.message)
    }
  }

  // Imported history is excluded from every timed scan (`imported_at IS NULL`). Migrating a shop
  // means loading years of quotes and invoices from the tool they just left — without this, the
  // first tick after an import emails their entire customer base about 2024 paperwork.
  for (const a of listAutomations()) {
    if (!a.enabled) continue
    const days = Number(a.params?.days)

    if (a.trigger === 'estimate.stale') {
      for (const e of all(`SELECT * FROM estimates WHERE status = 'sent' AND sent_at IS NOT NULL
          AND imported_at IS NULL
          AND sent_at <= datetime('now', ?)`, `-${days || 3} days`)) {
        if (overBudget()) break
        if (already('estimate.stale', e.id, a.id)) continue
        runAutomation(a, 'estimate.stale', { estimate: e, total: e.total, days: days || 3, contact: get('SELECT * FROM contacts WHERE id = ?', e.contact_id) }, deps, resumeAt('estimate.stale', e.id, a.id))
        fired.push(`estimate.stale ${e.estimate_number}`)
      }
    }

    if (a.trigger === 'invoice.overdue') {
      for (const i of all(`SELECT * FROM invoices WHERE status NOT IN ('paid','void') AND due_date IS NOT NULL
          AND imported_at IS NULL AND COALESCE(payment_review,'')=''
          AND due_date <= date('now', ?)`, `-${days || 1} days`)) {
        if (overBudget()) break
        if (already('invoice.overdue', i.id, a.id)) continue
        runAutomation(a, 'invoice.overdue', { invoice: i, total: round2(i.amount_due - i.amount_paid), days: days || 1, contact: get('SELECT * FROM contacts WHERE id = ?', i.contact_id) }, deps, resumeAt('invoice.overdue', i.id, a.id))
        fired.push(`invoice.overdue ${i.invoice_number}`)
      }
    }

    if (a.trigger === 'art.waiting') {
      for (const v of all(`SELECT av.*, j.id AS jid FROM art_versions av JOIN jobs j ON j.id = av.job_id
          WHERE av.status = 'sent' AND j.imported_at IS NULL
          AND av.sent_at <= datetime('now', ?)`, `-${days || 2} days`)) {
        if (overBudget()) break
        if (already('art.waiting', v.jid, a.id)) continue
        const job = get('SELECT * FROM jobs WHERE id = ?', v.jid)
        runAutomation(a, 'art.waiting', { job, version: v.version, days: days || 2, contact: get('SELECT * FROM contacts WHERE id = ?', job.contact_id) }, deps, resumeAt('art.waiting', job.id, a.id))
        fired.push(`art.waiting ${job.job_number}`)
      }
    }

    if (a.trigger === 'job.due_soon') {
      for (const j of all(`SELECT * FROM jobs WHERE status = 'active' AND due_date IS NOT NULL
          AND imported_at IS NULL
          AND due_date <= date('now', ?) AND due_date >= date('now')`, `+${days || 2} days`)) {
        if (overBudget()) break
        if (already('job.due_soon', j.id, a.id)) continue
        runAutomation(a, 'job.due_soon', { job: j, days: days || 2, contact: get('SELECT * FROM contacts WHERE id = ?', j.contact_id) }, deps, resumeAt('job.due_soon', j.id, a.id))
        fired.push(`job.due_soon ${j.job_number}`)
      }
    }

    if (a.trigger === 'job.at_risk') {
      for (const j of all(`SELECT * FROM jobs WHERE status = 'active' AND approval_gated = 1
          AND imported_at IS NULL
          AND art_approved_at IS NULL AND due_date IS NOT NULL AND stage IN ('new','art_approval')`)) {
        if (overBudget()) break
        const s = scheduleFor(j)
        if (!s.slip || s.slip <= 0 || already('job.at_risk', j.id, a.id)) continue
        runAutomation(a, 'job.at_risk', { job: j, days: s.slip, contact: get('SELECT * FROM contacts WHERE id = ?', j.contact_id) }, deps, resumeAt('job.at_risk', j.id, a.id))
        fired.push(`job.at_risk ${j.job_number}`)
      }
    }
  }
  return fired
}

/* ---------- starter pack ---------- */

/**
 * Rules a real shop would actually want on day one. Shipped enabled so the feature is
 * visibly doing work in the preview rather than being an empty builder.
 */
export const STARTER_AUTOMATIONS = [
  {
    name: 'Chase a quote after 3 quiet days',
    trigger: 'estimate.stale', params: { days: 3 }, conditions: [],
    actions: [{ key: 'email.customer', config: { subject: 'Still good on estimate {{estimate_number}}?',
      body: 'Hi {{first_name}},\n\nJust circling back on {{estimate_number}} for {{total}} — it is still good on our end and we have room on the schedule.\n\nWant us to get it moving?\n\n— {{shop_name}}' } }],
  },
  {
    name: 'Nudge a proof sitting 2+ days',
    trigger: 'art.waiting', params: { days: 2 }, conditions: [],
    actions: [
      { key: 'email.customer', config: { subject: 'Quick approval needed — {{job_title}}',
        body: 'Hi {{first_name}},\n\nProof v{{version}} for {{job_title}} has been waiting {{days}} days. Production starts the day you approve, so the sooner we hear back the safer your date is.\n\n— {{shop_name}}' } },
      { key: 'notify.staff', config: { body: 'Proof for {{job_number}} still unanswered after {{days}} days — worth a phone call.' } },
    ],
  },
  {
    name: 'Warn the shop when a deadline slips',
    trigger: 'job.at_risk', params: {}, conditions: [],
    actions: [{ key: 'notify.staff', config: { body: '{{job_number}} ({{job_title}}) can no longer make {{due_date}} — the proof is still out. Call the customer or reset the date.' } }],
  },
  {
    name: 'Thank the customer when they pay',
    trigger: 'invoice.paid', params: {}, conditions: [],
    actions: [
      { key: 'email.customer', config: { subject: 'Thanks — {{invoice_number}} is paid',
        body: 'Hi {{first_name}},\n\nGot the payment on {{invoice_number}}. Thank you.\n\nIf the crew liked the shirts, a quick review helps us more than anything.\n\n— {{shop_name}}' } },
      { key: 'contact.tag', config: { tag: 'paid-in-full' } },
    ],
  },
  {
    name: 'Ask for a review when the job ships',
    trigger: 'job.stage', params: { stage: 'shipping' }, conditions: [],
    actions: [{ key: 'sms.customer', config: { body: 'Hi {{first_name}} — {{job_title}} just shipped. If it lands well, would you leave us a review? — {{shop_name}}' } }],
  },
  {
    name: 'Flag big quotes for a personal call',
    trigger: 'estimate.sent', params: {}, conditions: [{ key: 'total_over', value: 5000 }],
    actions: [{ key: 'notify.staff', config: { body: 'Big one: {{estimate_number}} for {{total}} went to {{contact_name}}. Call, do not just email.' } }],
  },
  {
    name: 'Chase money the day it goes late',
    trigger: 'invoice.overdue', params: { days: 1 }, conditions: [],
    actions: [{ key: 'email.customer', config: { subject: 'Invoice {{invoice_number}} is past due',
      body: 'Hi {{first_name}},\n\n{{invoice_number}} was due {{due_date}} and shows {{total}} outstanding. If it is already on the way, ignore this.\n\n— {{shop_name}}' } }],
  },
  {
    // A real multi-step sequence: greet now, wait, then follow up. This is the GHL workflow.
    name: 'New lead nurture (3-step)',
    trigger: 'contact.created', params: {}, conditions: [],
    actions: [
      { key: 'email.customer', config: { subject: 'Thanks for reaching out to {{shop_name}}',
        body: 'Hi {{first_name}},\n\nThanks for getting in touch. Send over your art and quantities and we will turn a quote around fast.\n\n— {{shop_name}}' } },
      { key: 'wait', config: { days: 2 } },
      { key: 'sms.customer', config: { body: 'Hi {{first_name}} — following up from {{shop_name}}. Happy to quote whenever you are ready. Just reply here.' } },
      { key: 'notify.staff', config: { body: 'New lead {{contact_name}} has gone 2 days without a quote — worth a personal call.' } },
    ],
  },
  {
    name: 'Win-back after a lost deal',
    trigger: 'opportunity.lost', params: {}, conditions: [],
    actions: [
      { key: 'contact.tag', config: { tag: 'lost-deal' } },
      { key: 'wait', config: { days: 30 } },
      { key: 'email.customer', config: { subject: 'Still printing?',
        body: 'Hi {{first_name}},\n\nWe quoted you a while back and did not get to work together that time. If you have anything coming up, we would love another shot — and we will sharpen the pencil.\n\n— {{shop_name}}' } },
    ],
  },
  {
    name: 'Thank + ask review on a won deal',
    trigger: 'opportunity.won', params: {}, conditions: [{ key: 'total_over', value: 1500 }],
    actions: [{ key: 'notify.staff', config: { body: 'Won: {{contact_name}} for {{total}}. Nice. Make sure the first proof is extra sharp.' } }],
  },
  {
    name: 'Answer inbound within the hour',
    trigger: 'conversation.received', params: {}, conditions: [],
    actions: [{ key: 'notify.staff', config: { body: '{{contact_name}} just messaged — reply while it is warm.' } }],
  },
]

/* -------------------------------------------------------------------------------------------------
 * The starter rules are seeded ONCE, and once means once.
 *
 * The guard used to be `if (there are any rows) return` — a state test, not a latch — and
 * bootstrapDb calls this on every tenant-database open, i.e. on the first request for each shop
 * after every restart and every deploy. So a shop that switched the starter rules off by DELETING
 * them from the Automations screen had all eleven back, every one enabled, at the next deploy,
 * with nothing on any screen to explain it. Delete them again, they come back again.
 *
 * Seven of the eleven send something to a real customer: the quote chase, the proof nudge, the
 * thank-you, the late-invoice chase, the three-step nurture and the win-back all go out over the
 * shop's own SMTP, and "Ask for a review when the job ships" goes over its Twilio token, which is
 * money per message.
 *
 * lib/db.mjs's once() exists for precisely this shape and says so — "an UPDATE guarded by
 * does-this-still-look-untouched re-fires forever". This seed never used it.
 * ---------------------------------------------------------------------------------------------- */
const SEED_LATCH = 'seed_starter_automations'

export function seedAutomations() {
  if (get('SELECT 1 AS x FROM schema_migrations WHERE name = ?', SEED_LATCH)) return 0
  // Two shapes of database that must be latched WITHOUT being written to: one that already
  // carries rules (it was seeded before this latch existed), and one that has been used but has
  // no rules left (the shop deleted them — that was a decision, not a missing seed). A genuinely
  // new shop is seeded before it has a single customer, which is what tells the two apart.
  const seededAlready = get('SELECT COUNT(*) AS c FROM automations').c > 0
  const notNew = get('SELECT COUNT(*) AS c FROM contacts').c > 0 || get('SELECT COUNT(*) AS c FROM automation_runs').c > 0
  if (seededAlready || notNew) {
    run('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)', SEED_LATCH)
    return 0
  }
  // The rows and the latch land together: a kill in the middle must not leave a half-seeded shop
  // that then seeds again on top of itself.
  tx(() => {
    for (const a of STARTER_AUTOMATIONS) {
      run('INSERT INTO automations (name, enabled, trigger, params, conditions, actions, created_at) VALUES (?,?,?,?,?,?,?)',
        a.name, 1, a.trigger, JSON.stringify(a.params || {}), JSON.stringify(a.conditions || []), JSON.stringify(a.actions || []), now())
    }
    run('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)', SEED_LATCH)
  })
  return STARTER_AUTOMATIONS.length
}
