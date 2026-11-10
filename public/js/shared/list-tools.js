/**
 * Search, sort and "show more" for the long lists (estimates, invoices).
 *
 * A shop with a year of work has hundreds of each. The lists rendered every row at once — 160
 * estimates was a 12,000px page — with no way to find one except the status tabs and the browser's
 * own find. This keeps the rows the server already sent and narrows them in the browser: no new
 * request per keystroke, and the same table markup the views already draw.
 *
 * Pure functions plus two tiny markup helpers, so it is testable in Node.
 */
export const PAGE = 50

/** A fresh, per-view state. `shown` grows by PAGE each time "Show more" is pressed. */
export const listState = (sort = '', dir = 'desc') => ({ q: '', sort, dir, shown: PAGE })

const norm = (v) => String(v ?? '').toLowerCase()

/**
 * @param rows   the rows as fetched
 * @param state  { q, sort, dir, shown }
 * @param cols   { key: (row) => string | number } — every column that can be sorted on
 * @param text   (row) => string — what the search box matches against
 * @returns { rows: the slice to draw, matched: how many matched the search, total }
 */
export function applyList(rows, state, cols, text) {
  const words = norm(state.q).split(/\s+/).filter(Boolean)
  let out = words.length ? rows.filter((r) => { const hay = norm(text(r)); return words.every((w) => hay.includes(w)) }) : rows.slice()
  const pick = cols[state.sort]
  if (pick) {
    const sign = state.dir === 'asc' ? 1 : -1
    out = out.map((r, i) => [pick(r), i, r]).sort((a, b) => {
      const x = a[0], y = b[0]
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true, sensitivity: 'base' })
      return c ? c * sign : a[1] - b[1] // stable: ties keep the server's order
    }).map((t) => t[2])
  }
  return { rows: out.slice(0, state.shown), matched: out.length, total: rows.length }
}

const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** A sortable column heading. The button is the control; aria-sort on the th says the state. */
export function sortTh(label, key, state, cls = '') {
  const on = state.sort === key
  return `<th${cls ? ` class="${cls}"` : ''}${on ? ` aria-sort="${state.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}><button type="button" data-sort="${escAttr(key)}" title="Sort by ${escAttr(label.toLowerCase())}" style="background:none;border:0;padding:0;margin:0;font:inherit;color:inherit;letter-spacing:inherit;text-transform:inherit;cursor:pointer">${escAttr(label)}<span aria-hidden="true" style="opacity:${on ? 1 : 0.35}"> ${on ? (state.dir === 'asc' ? '▲' : '▼') : '↕'}</span></button></th>`
}

/** Clicking the heading that is already sorted flips it; a new heading starts where it reads best. */
export function toggleSort(state, key, firstDir = 'asc') {
  if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc'
  else { state.sort = key; state.dir = firstDir }
  state.shown = PAGE
}

/** The row under the table: how many are showing, and the way to the rest. */
export function listFoot(r, noun) {
  if (r.matched <= r.rows.length) return r.matched !== r.total ? `<div class="dim" style="padding:12px 16px;font-size:12px">${r.matched} of ${r.total} ${noun}s match</div>` : ''
  const more = Math.min(PAGE, r.matched - r.rows.length)
  return `<div style="padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <span class="dim" style="font-size:12px">Showing ${r.rows.length} of ${r.matched}${r.matched !== r.total ? ` matching (${r.total} in all)` : ''}</span>
    <button type="button" class="btn ghost sm" data-more-rows>Show ${more} more</button></div>`
}
