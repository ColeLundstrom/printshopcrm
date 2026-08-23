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
      'quoted', round2(estimate.total), 'estimate', now(), now()).lastInsertRowid)
    opp = get('SELECT * FROM opportunities WHERE id = ?', id)
  }
  // Only advance — never regress a deal that's further along than the event implies.
  const rank = (s) => STAGE_KEYS.indexOf(s)
  const advance = (target) => { if (rank(target) > rank(opp.stage) && opp.stage !== 'won' && opp.stage !== 'lost') setStage(opp.id, target) }
  run('UPDATE opportunities SET value = ?, updated_at = ? WHERE id = ?', round2(estimate.total), now(), opp.id)
  if (event === 'sent') advance('sent')
  if (event === 'approved') setStage(opp.id, 'won')
  if (event === 'declined') setStage(opp.id, 'lost')
  return get('SELECT * FROM opportunities WHERE id = ?', opp.id)
}

const safeItems = (s) => { try { return JSON.parse(s) } catch { return [] } }

/** Board payload: columns with jobs, plus the numbers a shop owner watches. */
export function pipelineBoard() {
  const opps = all(`SELECT o.*, c.name AS contact_name, c.company FROM opportunities o
    LEFT JOIN contacts c ON c.id = o.contact_id ORDER BY o.sort_order, o.id`)
  const columns = STAGES.map((s) => {
    const list = opps.filter((o) => o.stage === s.key)
    return { ...s, opps: list, value: round2(list.reduce((t, o) => t + (o.value || 0), 0)) }
  })
  const open = opps.filter((o) => o.stage !== 'won' && o.stage !== 'lost')
  const won = opps.filter((o) => o.stage === 'won')
  const lost = opps.filter((o) => o.stage === 'lost')
  const decided = won.length + lost.length
  return {
    stages: STAGES, columns,
    stats: {
      open_value: round2(open.reduce((t, o) => t + (o.value || 0), 0)),
      weighted_value: round2(open.reduce((t, o) => t + (o.value || 0) * probOf(o.stage), 0)),
      won_value: round2(won.reduce((t, o) => t + (o.value || 0), 0)),
      open_count: open.length,
      win_rate: decided ? Math.round((won.length / decided) * 100) : null,
    },
  }
}
