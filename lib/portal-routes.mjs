/**
 * The customer portal: ONE link per customer that lists everything the shop has already handed
 * them — quotes to approve, proofs to sign off, invoices to pay, jobs on the floor.
 *
 * Until now a customer collected a separate /p/ link per document, scattered across weeks of
 * email, and "where's my order?" was a phone call. This page is an index over those same links,
 * not a second copy of them: approving, deciding and paying still happen on /p/estimate, /p/art
 * and /p/pay, with their guards (approve-once, superseded proofs, void invoices, payment review)
 * intact. Nothing here mutates a document.
 *
 * What it shows is deliberately no more than the individual links would. A draft estimate has
 * never been sent (and a revised quote is put back to draft with a rotated share_key precisely so
 * the old link dies), a draft proof has never been sent, a void invoice owes nothing — none of
 * those ever reached the customer, so none of them appear here.
 */
import crypto from 'node:crypto'
import { all, get, run, getDb, shopFormat, getSettings, EFFECTIVE_STATUS_SQL, JOB_STAGES, todayIso } from './db.mjs'

// The link token is token('account', contactId, slug, key), the same HMAC every /p/ link uses, so
// it is tenant-scoped (a link replayed with another shop's ?s= hashes a different slug) and cannot
// be minted without the server SECRET. `key` is a per-customer random value for the same reason
// share_key exists on estimates/invoices: contacts.id is a REUSABLE rowid, and a link that was a
// pure function of it would open the NEXT customer's whole account once the first was deleted.
// It lives in its own table rather than a new contacts column so contact exports, the v1 API and
// every `SELECT * FROM contacts` stay byte-identical; ON DELETE CASCADE kills the key with the
// customer, and a reused id simply has no key until staff mint a fresh one.
const KEY_TABLE = `CREATE TABLE IF NOT EXISTS customer_portal_keys (
  contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  share_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`
const ready = new WeakSet()
const ensure = () => { const d = getDb(); if (!ready.has(d)) { d.exec(KEY_TABLE); ready.add(d) } }
const keyOf = (id) => { ensure(); return get('SELECT share_key FROM customer_portal_keys WHERE contact_id = ?', id)?.share_key || '' }
const mintKey = (id) => {
  ensure()
  if (!get('SELECT 1 FROM contacts WHERE id = ?', id)) return ''
  run('INSERT OR IGNORE INTO customer_portal_keys(contact_id, share_key) VALUES(?, ?)', id, crypto.randomBytes(8).toString('hex'))
  return keyOf(id)
}

// Customer-facing labels. The staff pills say "sent"/"partial"; a customer reads "Awaiting your
// approval" and "Part paid".
const EST_LABEL = { sent: 'Awaiting your approval', approved: 'Approved', invoiced: 'Approved · invoiced', declined: 'Declined', expired: 'Expired' }
const INV_LABEL = { unpaid: 'Due', partial: 'Part paid', overdue: 'Overdue', paid: 'Paid' }
const LIST_CAP = 25 // a ten-year customer should not get a 600-row page; the newest are what matter

export function registerPortalRoutes(app, { pPage, page, esc, logoImg, joinDot, token, shareUrl, paymentsReady, proofIsCurrent, publicOrigin, wrap }) {
  const accountPath = (id) => { const k = mintKey(id); return k ? shareUrl('account', id, k) : '' }
  const verify = (id, given) => {
    const k = keyOf(id)
    if (!k) return false
    const want = Buffer.from(token('account', id, undefined, k)), got = Buffer.from(String(given || ''))
    return want.length === got.length && crypto.timingSafeEqual(want, got)
  }
  const fmt = () => shopFormat()
  // Dates through the shop's own locale (never a hard-coded en-US) and in UTC, because due dates
  // are stored as bare YYYY-MM-DD and a local-zone parse prints the day before west of Greenwich.
  const day = (s) => {
    if (!s) return ''
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? `${s}T00:00:00Z` : `${String(s).replace(' ', 'T')}Z`)
    if (Number.isNaN(d.getTime())) return esc(s)
    try { return esc(new Intl.DateTimeFormat(fmt().locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(d)) } catch { return esc(String(s).slice(0, 10)) }
  }
  const expired = (res) => res.status(403).send(page('Link expired', '<div class="wrap"><div class="card"><h1>Link expired</h1><p>Ask the shop to resend your customer portal link.</p></div></div>'))

  // Staff: the copyable link for the contact detail page. Same gate as GET /api/contacts/:id — any
  // signed-in member who can open the customer can already copy each document's own share link.
  app.get('/api/contacts/:id/portal-link', wrap((req, res) => {
    const id = Number(req.params.id)
    const path = Number.isSafeInteger(id) && id > 0 ? accountPath(id) : ''
    if (!path) return res.status(404).json({ error: 'Customer not found', code: 'not_found' })
    res.json({ url: publicOrigin(req) + path })
  }))

  // Customer: the portal page itself. `t` is accepted as an alias of `k` so a hand-typed or
  // documented ?t= link works; every link this server generates carries ?k= like its siblings.
  app.get('/p/account/:id', pPage((req, res) => {
    const id = Number(req.params.id)
    if (!Number.isSafeInteger(id) || id <= 0 || !verify(id, req.query.k ?? req.query.t)) return expired(res)
    const c = get('SELECT * FROM contacts WHERE id = ?', id)
    if (!c) return res.status(404).send(page('Not found', '<div class="wrap"><div class="card"><h1>Not found</h1></div></div>'))
    const s = getSettings(), f = fmt()
    res.setHeader('Cache-Control', 'private, no-store') // balances change; a shared device must not replay yesterday's

    const estimates = all(`SELECT id, estimate_number, status, total, created_at, sent_at, share_key FROM estimates
      WHERE contact_id = ? AND status != 'draft' ORDER BY (status = 'sent') DESC, id DESC LIMIT ${LIST_CAP}`, id)
    const invoices = all(`SELECT i.id, i.invoice_number, i.amount_due, i.amount_paid, i.due_date, i.created_at, i.payment_review, i.share_key,
        ${EFFECTIVE_STATUS_SQL} AS status FROM invoices i
      WHERE i.contact_id = ? AND i.status != 'void' ORDER BY (i.amount_paid < i.amount_due - 0.005) DESC, i.id DESC LIMIT ${LIST_CAP}`, todayIso(), id)
    // A proof belongs to this customer through its job, or — for an estimate-attached mockup with
    // no job yet — through its quote. Only SENT and CURRENT proofs are awaiting a decision: a
    // superseded version's own page refuses decisions, so listing it would be a dead end.
    const proofs = all(`SELECT a.id, a.version, a.original_name, a.status, a.sent_at, a.job_id, a.estimate_id, a.share_key,
        j.title AS job_title, j.job_number, e.estimate_number
      FROM art_versions a LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN estimates e ON e.id = a.estimate_id
      WHERE a.status = 'sent' AND (j.contact_id = ? OR (a.job_id IS NULL AND e.contact_id = ?))
      ORDER BY a.id DESC LIMIT ${LIST_CAP}`, id, id).filter(proofIsCurrent)
    const jobs = all(`SELECT id, job_number, title, stage, due_date, rush FROM jobs
      WHERE contact_id = ? AND status != 'complete' AND stage != 'complete'
      ORDER BY (due_date IS NULL OR due_date = ''), due_date, id DESC LIMIT ${LIST_CAP}`, id)

    const bal = (i) => Math.max(0, Math.round(((Number(i.amount_due) || 0) - (Number(i.amount_paid) || 0)) * 100) / 100)
    const owed = invoices.reduce((t, i) => t + bal(i), 0)
    const toApprove = estimates.filter((e) => e.status === 'sent').length + proofs.length
    const canPay = paymentsReady(s)

    const section = (title, count, body, empty) => `<section class="pt-sec"><h2>${title}${count ? ` <span class="pt-count">${count}</span>` : ''}</h2>${body || `<p class="pt-empty">${empty}</p>`}</section>`
    const row = (main, sub, side, action) => `<div class="pt-row"><div class="pt-main"><div class="pt-title">${main}</div>${sub ? `<div class="pt-sub">${sub}</div>` : ''}</div>`
      + `<div class="pt-side">${side}${action ? `<div class="pt-act">${action}</div>` : ''}</div></div>`
    const pill = (text, tone = '') => `<span class="pt-pill ${tone}">${esc(text)}</span>`

    const estHtml = estimates.map((e) => row(
      `Estimate ${esc(e.estimate_number)}`, day(e.sent_at || e.created_at),
      `<strong>${esc(f.money(e.total))}</strong>${pill(EST_LABEL[e.status] || e.status, e.status === 'sent' ? 'due' : 'ok')}`,
      `<a class="btn ${e.status === 'sent' ? '' : 'ghost'} sm" href="${esc(shareUrl('estimate', e.id, e.share_key))}">${e.status === 'sent' ? 'Review &amp; approve' : 'View'}</a>`)).join('')

    const proofHtml = proofs.map((a) => row(
      `${a.job_id ? esc(a.job_title || 'Artwork') : 'Mockup'} · proof v${esc(a.version)}`,
      joinDot(a.job_number ? esc(a.job_number) : a.estimate_number ? `Estimate ${esc(a.estimate_number)}` : '', day(a.sent_at)),
      pill('Needs your decision', 'due'),
      `<a class="btn sm" href="${esc(shareUrl('art', a.id, a.share_key))}">Review proof</a>`)).join('')

    const invHtml = invoices.map((i) => {
      const b = bal(i), review = !!i.payment_review
      // Pay only where /p/pay would actually take a card: a positive balance, online payment set
      // up, and no refund/payment review in progress (that page refuses to collect during one).
      const action = b > 0 && canPay && !review
        ? `<a class="btn sm" href="${esc(shareUrl('pay', i.id, i.share_key))}">Pay ${esc(f.money(b))}</a>`
        : `<a class="btn ghost sm" href="${esc(shareUrl('pay', i.id, i.share_key))}">View</a>`
      const tone = i.status === 'paid' ? 'ok' : i.status === 'overdue' ? 'late' : 'due'
      return row(`Invoice ${esc(i.invoice_number)}`,
        joinDot(`Total ${esc(f.money(i.amount_due))}`, i.due_date && b > 0 ? `due ${day(i.due_date)}` : '', review ? 'under review — please don’t pay again' : ''),
        `<strong>${esc(f.money(b))}</strong>${pill(review ? 'Under review' : INV_LABEL[i.status] || i.status, review ? 'late' : tone)}`, action)
    }).join('')

    const jobHtml = jobs.map((j) => {
      const cur = Math.max(0, JOB_STAGES.findIndex((st) => st.key === j.stage))
      const steps = `<ol class="pt-steps" aria-label="Progress">${JOB_STAGES.map((st, n) =>
        `<li class="${n < cur ? 'done' : n === cur ? 'now' : ''}"${n === cur ? ' aria-current="step"' : ''}><span>${esc(st.label)}</span></li>`).join('')}</ol>`
      return `<div class="pt-job"><div class="pt-row"><div class="pt-main"><div class="pt-title">${esc(j.title || 'Your order')}</div>`
        + `<div class="pt-sub">${joinDot(esc(j.job_number), j.due_date ? `due ${day(j.due_date)}` : '', j.rush ? 'rush' : '')}</div></div>`
        + `<div class="pt-side">${pill(JOB_STAGES[cur]?.label || j.stage, 'ok')}</div></div>${steps}</div>`
    }).join('')

    res.send(page(`${esc(s.shop_name || 'Your orders')} · Your orders`, `<div class="wrap pt">
      <div class="card">
        <div class="head"><div>${logoImg(s)}<div class="shop">${esc(s.shop_name)}</div><div class="tag">${esc(s.shop_tagline)}</div></div>
          <div class="right"><div class="doc">YOUR ORDERS</div><div class="num2">${esc(c.name)}${c.company ? ` · ${esc(c.company)}` : ''}</div></div></div>
        <div class="pt-kpis">
          <div class="pt-kpi ${owed > 0.005 ? 'due' : ''}"><div class="lbl">Balance due</div><div class="val">${esc(f.money(owed))}</div></div>
          <div class="pt-kpi ${toApprove ? 'due' : ''}"><div class="lbl">Waiting on you</div><div class="val">${toApprove}</div></div>
          <div class="pt-kpi"><div class="lbl">In production</div><div class="val">${jobs.length}</div></div>
        </div>
        ${section('Proofs to review', proofs.length, proofHtml, 'No proofs waiting on you.')}
        ${section('Estimates', estimates.length, estHtml, 'No estimates yet.')}
        ${section('Invoices', invoices.length, invHtml, 'No invoices yet.')}
        ${section('Jobs in progress', jobs.length, jobHtml, 'Nothing on the production floor right now.')}
      </div><div class="foot">${joinDot(esc(s.shop_name), esc(s.shop_phone), esc(s.shop_email))}</div></div>`))
  }))

  return {
    /** "All your orders →" for the individual /p/ pages; '' when the contact is gone. The visitor
     *  already proved they hold a valid link to one of this customer's documents. */
    allOrdersLink(contactId) {
      const id = Number(contactId)
      if (!Number.isSafeInteger(id) || id <= 0) return ''
      try { const p = accountPath(id); return p ? `<div class="all-orders"><a href="${esc(p)}">All your orders →</a></div>` : '' }
      catch (e) { console.error('portal-link:', e.message); return '' }
    },
  }
}
