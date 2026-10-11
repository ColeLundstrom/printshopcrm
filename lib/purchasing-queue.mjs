import { all, get } from './db.mjs'
import { pageOptions } from './paging.mjs'
import { purchaseOrderPlacement } from './suppliers.mjs'

const states = {
  attention: "status NOT IN ('closed','cancelled') AND (outstanding > 0 OR confirmed = 0 OR ordered = 0)",
  outstanding: "status NOT IN ('closed','cancelled') AND outstanding > 0",
  confirmation: "status NOT IN ('closed','cancelled') AND confirmed = 0",
  short_closed: "status = 'closed' AND outstanding > 0",
  received: "status NOT IN ('closed','cancelled') AND ordered > 0 AND outstanding = 0",
  all: '1 = 1'
}
// Aggregate lines before paging. The shortage is per size: over-receiving one line must not
// hide another line that is still missing. Jobs that have ended (or disappeared) remain visible.
const base = `WITH quantities AS (
  SELECT po_id, COALESCE(SUM(qty_ordered),0) AS ordered,
    COALESCE(SUM(qty_received),0) AS received,
    COALESCE(SUM(MAX(0,COALESCE(qty_ordered,0)-COALESCE(qty_received,0))),0) AS outstanding
  FROM po_lines GROUP BY po_id
), purchase_queue AS (
  SELECT p.id,j.id AS job_id,p.po_number,COALESCE(p.supplier,'') AS supplier,
    COALESCE(p.status,'draft') AS status,p.order_id,p.submitted_at,c.po_id AS manual_confirmation,
    j.job_number,j.title,j.due_date,j.status AS job_status,COALESCE(j.rush,0) AS rush,
    COALESCE(q.ordered,0) AS ordered,COALESCE(q.received,0) AS received,
    COALESCE(q.outstanding,0) AS outstanding,
    CASE WHEN c.po_id IS NOT NULL OR (COALESCE(p.order_id,'') != '' AND COALESCE(p.submitted_at,'') != '') THEN 1 ELSE 0 END AS confirmed
  FROM purchase_orders p LEFT JOIN jobs j ON j.id=p.job_id
    LEFT JOIN quantities q ON q.po_id=p.id LEFT JOIN po_manual_confirmations c ON c.po_id=p.id
), matching AS (
  SELECT * FROM purchase_queue WHERE (? = '' OR supplier = ?)
    AND (? = '' OR instr(lower(COALESCE(po_number,'') || ' ' || COALESCE(job_number,'') || ' ' || COALESCE(title,'') || ' ' || supplier),lower(?)) > 0)
)`

/** Read-only, tenant-scoped inventory of recorded POs. It never checks a supplier or receives goods. */
export function purchasingQueue({ state = 'attention', supplier = '', q = '', page = 1, pageSize = 25 } = {}) {
  const paging = pageOptions({ page, pageSize })
  if (typeof state !== 'string' || !Object.hasOwn(states, state) || typeof supplier !== 'string' || supplier.length > 100 || typeof q !== 'string' || q.length > 120)
    throw Object.assign(new Error('Choose a valid purchasing view; limit supplier to 100 and search to 120 characters.'), { status: 400 })
  q = q.trim()
  const params = [supplier, supplier, q, q]
  const summary = get(`${base} SELECT COUNT(*) AS recorded,
    COALESCE(SUM(CASE WHEN ${states.attention} THEN 1 ELSE 0 END),0) AS needs_attention,
    COALESCE(SUM(CASE WHEN ${states.confirmation} THEN 1 ELSE 0 END),0) AS needs_confirmation,
    COALESCE(SUM(CASE WHEN ${states.outstanding} THEN outstanding ELSE 0 END),0) AS outstanding_units,
    COALESCE(SUM(CASE WHEN ${states.short_closed} THEN 1 ELSE 0 END),0) AS short_closed,
    COALESCE(SUM(CASE WHEN ${states[state]} THEN 1 ELSE 0 END),0) AS filtered_total FROM matching`, ...params)
  const rows = all(`${base} SELECT * FROM matching WHERE ${states[state]}
    ORDER BY CASE WHEN COALESCE(due_date,'') = '' THEN 1 ELSE 0 END,due_date,rush DESC,id DESC LIMIT ? OFFSET ?`,
    ...params, paging.pageSize, (paging.page - 1) * paging.pageSize).map(row => {
    const placement_state = purchaseOrderPlacement(row)
    const { order_id, submitted_at, manual_confirmation, confirmed, ...safe } = row
    return { ...safe, placement_state, placement_confirmed: !!confirmed }
  })
  const { filtered_total: total, ...counts } = summary
  return { rows, summary: counts, suppliers: all("SELECT DISTINCT supplier FROM purchase_orders WHERE COALESCE(supplier,'') != '' ORDER BY supplier").map(row => row.supplier),
    state, supplier, q, page: paging.page, page_size: paging.pageSize, total, pages: Math.max(1, Math.ceil(total / paging.pageSize)) }
}
