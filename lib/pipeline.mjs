/**
 * Sales pipeline — GHL's opportunities, distinct from the production board.
 *
 * The production kanban tracks work that's already sold; this tracks whether it sells at
 * all. Keeping them separate is the point: a job in "Production" and a quote in "Sent" are
 * different questions ("will we finish it?" vs "will they say yes?"), and shops that merge
 * them lose the sales view. Opportunities auto-sync from estimate events so the shop never
 * maintains two lists by hand.
 */
import { all, get, run, now, round2 } from './db.mjs'

export const STAGES = [
  { key: 'lead', label: 'Lead', prob: 0.1 },
  { key: 'quoted', label: 'Quoted', prob: 0.3 },
  { key: 'sent', label: 'Sent', prob: 0.5 },
  { key: 'negotiation', label: 'Negotiating', prob: 0.7 },
  { key: 'won', label: 'Won', prob: 1 },
  { key: 'lost', label: 'Lost', prob: 0 },
]
export const STAGE_KEYS = STAGES.map((s) => s.key)
/**
 * The vocabulary is closed, and this is the one place that says so.
 *
 * A stage outside STAGE_KEYS is not merely untidy: pipelineBoard() builds its columns from STAGES,
 * so the card is drawn in NO column at all — it cannot be opened, edited, dragged or corrected
 * from any screen, and probOf() values it at zero in the weighted forecast. The two readers also
 * disagreed about whether to count it (pipelineStats used an allowlist, pipelineBoard a denylist),
 * so the Dashboard and the Pipeline board reported different open values out of the same table.
 * POST /api/opportunities has always guarded this; nothing else did.
 */
export const normStage = (s) => (STAGE_KEYS.includes(s) ? s : 'lead')
const probOf = (stage) => STAGES.find((s) => s.key === stage)?.prob ?? 0

/** The open opportunity tied to an estimate, if any. */
const oppForEstimate = (estimateId) => get('SELECT * FROM opportunities WHERE estimate_id = ?', estimateId)

/** Move an opportunity to a stage, stamping won/lost and logging nothing (caller logs). */
export function setStage(id, stage, { lost_reason } = {}) {
  const o = get('SELECT * FROM opportunities WHERE id = ?', id)
  if (!o || !STAGE_KEYS.includes(stage)) return o
  run(`UPDATE opportunities SET stage=?, won_at=?, lost_at=?, lost_reason=?, updated_at=? WHERE id=?`,
    stage,
    stage === 'won' ? (o.won_at || now()) : null,
    stage === 'lost' ? (o.lost_at || now()) : null,
    stage === 'lost' ? (lost_reason || o.lost_reason || '') : null,
    now(), id)
  return get('SELECT * FROM opportunities WHERE id = ?', id)
}

/**
 * Keep the pipeline in step with an estimate's life. Idempotent: creates the opportunity
 * the first time and only ever advances it, so re-firing an event can't move a Won deal
 * backwards.
 */
export function syncFromEstimate(estimate, event) {
  if (!estimate) return
  let opp = oppForEstimate(estimate.id)
  if (!opp) {
    const c = get('SELECT name FROM contacts WHERE id = ?', estimate.contact_id)
    const items = safeItems(estimate.items)
    const id = Number(run(`INSERT INTO opportunities (contact_id, estimate_id, title, stage, value, source, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?)`,
      estimate.contact_id, estimate.id,
      items[0]?.description || `Quote for ${c?.name || 'customer'}`,
      'quoted', dealValue(estimate), 'estimate', now(), now()).lastInsertRowid)
    opp = get('SELECT * FROM opportunities WHERE id = ?', id)
  }
  // Only advance — never regress a deal that's further along than the event implies.
  const rank = (s) => STAGE_KEYS.indexOf(s)
  const advance = (target) => { if (rank(target) > rank(opp.stage) && opp.stage !== 'won' && opp.stage !== 'lost') setStage(opp.id, target) }
  run('UPDATE opportunities SET value = ?, updated_at = ? WHERE id = ?', dealValue(estimate), now(), opp.id)
  if (event === 'sent') advance('sent')
  if (event === 'approved') setStage(opp.id, 'won')
  if (event === 'declined') setStage(opp.id, 'lost')
  return get('SELECT * FROM opportunities WHERE id = ?', opp.id)
}

/**
 * What a deal is worth to the shop.
 *
 * This used to be `estimate.total`, which is subtotal + sales tax — so the forecast, the board
 * columns and the dashboard's "open estimates" KPI all counted money the shop collects on behalf
 * of the state as revenue it was going to keep. On the seeded shop that is $666.35 of open value,
 * $934.54 of won value and $1,098.92 on the KPI, and it grows with the tax rate: a 9.5% shop
 * reads its whole forecast a tenth high.
 *
 * Same expression lib/roi.mjs:orderValue uses, so the pipeline and per-job profitability cannot
 * quote two different numbers for one order again.
 */
const dealValue = (estimate) => round2(Number(estimate.subtotal) || Number(estimate.total) || 0)

const safeItems = (s) => { try { return JSON.parse(s) } catch { return [] } }

/**
 * The five numbers the dashboard shows — without building the board to get them.
 *
 * /api/dashboard is the first screen after login and it called pipelineBoard().stats, which
 * SELECTs every opportunity the shop has ever had (`SCAN o` + a temp b-tree for the ORDER BY),
 * joins contacts onto each one, and then builds nine more arrays out of the result — six per-stage
 * columns plus open/won/lost. Measured on 29,910 opportunities: 154.5 ms of blocked event loop and
 * 34.7 MB of heap growth, out of a warm dashboard total of ~200 ms, to produce five scalars. Every
 * other dashboard query on that route costs 0-25 ms. The app auto-creates an opportunity for every
 * estimate, so this grows for the life of the shop and node:sqlite is synchronous — the block is
 * charged to every other tenant on the box too.
 *
 * One GROUP BY over six stages, then the same fold in JS. GET /api/pipeline still calls
 * pipelineBoard(), because that screen genuinely draws the cards.
 */
export function pipelineStats() {
  // Fold any stage the board has no column for into 'lead' rather than dropping it. A deal the
  // Dashboard silently does not count is a deal the shop is quietly wrong about; normStage is what
  // stops one bad row — an old backup, a hand-edited database, the next bug — being invisible
  // instead of merely mislabelled, and it keeps this number identical to pipelineBoard()'s.
  const byStage = new Map()
  for (const r of all(`SELECT stage, COUNT(*) AS n, COALESCE(SUM(value), 0) AS v
    FROM opportunities GROUP BY stage`)) {
    const k = normStage(r.stage)
    const e = byStage.get(k) || { n: 0, v: 0 }
    byStage.set(k, { n: e.n + r.n, v: e.v + r.v })
  }
  const sum = (keys, f) => keys.reduce((t, k) => t + f(byStage.get(k) || { n: 0, v: 0 }, k), 0)
  const openKeys = STAGE_KEYS.filter((k) => k !== 'won' && k !== 'lost')
  const wonN = (byStage.get('won') || { n: 0 }).n
  const decided = wonN + (byStage.get('lost') || { n: 0 }).n
  return {
    open_value: round2(sum(openKeys, (r) => r.v)),
    weighted_value: round2(sum(openKeys, (r, k) => r.v * probOf(k))),
    won_value: round2((byStage.get('won') || { v: 0 }).v),
    open_count: sum(openKeys, (r) => r.n),
    win_rate: decided ? Math.round((wonN / decided) * 100) : null,
  }
}

/** Board payload: columns with jobs, plus the numbers a shop owner watches. */
export function pipelineBoard() {
  const opps = all(`SELECT o.*, c.name AS contact_name, c.company FROM opportunities o
    LEFT JOIN contacts c ON c.id = o.contact_id ORDER BY o.sort_order, o.id`)
  // A card whose stage matches no column was drawn NOWHERE — visible in the header's total,
  // reachable from no screen, correctable by nobody. Bucket it into 'lead' so there is always
  // somewhere to drag it out of.
  const stageOf = (o) => normStage(o.stage)
  const columns = STAGES.map((s) => {
    const list = opps.filter((o) => stageOf(o) === s.key)
    return { ...s, opps: list, value: round2(list.reduce((t, o) => t + (o.value || 0), 0)) }
  })
  // The SAME allowlist pipelineStats() uses, not a denylist. These two numbers are read side by
  // side — the Dashboard's KPI and this board's own header — and a denylist counted a stage that
  // does not exist while the allowlist dropped it, so one unknown value made them disagree.
  const openKeys = STAGE_KEYS.filter((k) => k !== 'won' && k !== 'lost')
  const open = opps.filter((o) => openKeys.includes(stageOf(o)))
  const won = opps.filter((o) => stageOf(o) === 'won')
  const lost = opps.filter((o) => stageOf(o) === 'lost')
  const decided = won.length + lost.length
  return {
    stages: STAGES, columns,
    stats: {
      open_value: round2(open.reduce((t, o) => t + (o.value || 0), 0)),
      weighted_value: round2(open.reduce((t, o) => t + (o.value || 0) * probOf(stageOf(o)), 0)),
      won_value: round2(won.reduce((t, o) => t + (o.value || 0), 0)),
      open_count: open.length,
      win_rate: decided ? Math.round((won.length / decided) * 100) : null,
    },
  }
}
