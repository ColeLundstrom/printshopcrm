import { guardWorkflowStage } from './production.mjs'
/**
 * The Assistant — "message your problem, it's handled."
 *
 * A shop owner types plain English ("quote 48 navy hoodies for the robotics team",
 * "who owes me money", "move the Wildcats job to production") and this turns it into a
 * real action or a real answer. It is a TOOL ROUTER, not a chatbot: it classifies intent,
 * resolves the entities against the shop's data, and either does the thing or reports it —
 * always returning links so the human can take over manually. AI-first, manual-always.
 *
 * It runs deterministically (no model needed) for the common commands, and hands anything
 * it can't classify to the model when one is reachable. Every write it makes is a normal
 * record the human can edit or reverse in the UI.
 */
import { all, get, run, now, round2, getSettings, shopFormat, logActivity, freezeUpcharges,
  syncInvoiceStatus, nextEstimateNumber, sizeTotal, sizeSummary, rollupSizes, lineQty, taxRateFor, emitPaymentRecorded, stampShipDate } from './db.mjs'
import { priceIntakeLive } from './quickquote.mjs'
import { dealValue } from './pipeline.mjs'
import { parseIntake, aiStatus, draftReply } from './ai.mjs'

// The shop's own currency and locale, read per call (see lib/db.mjs shopFormat).
const money = (n) => shopFormat().money(n)
const money0 = (n) => shopFormat().money0(n)

const STAGE_WORDS = {
  new: 'new', queue: 'new', 'art approval': 'art_approval', art: 'art_approval', approval: 'art_approval',
  prepress: 'prepress', 'pre press': 'prepress', production: 'production', printing: 'production', press: 'production',
  qc: 'qc', quality: 'qc', shipping: 'shipping', ship: 'shipping', shipped: 'shipping', complete: 'complete', done: 'complete',
}
const STAGE_LABEL = { new: 'New', art_approval: 'Art Approval', prepress: 'Prepress', production: 'Production', qc: 'QC', shipping: 'Shipping', complete: 'Complete' }

/* ---------- entity resolution ---------- */

const findContact = (name) => {
  const q = `%${String(name).trim().toLowerCase()}%`
  return get(`SELECT * FROM contacts WHERE lower(name) LIKE ? OR lower(COALESCE(company,'')) LIKE ? ORDER BY length(name) LIMIT 1`, q, q)
}
const findJob = (token) => {
  const t = String(token).trim()
  const num = t.match(/\d{3,}/)?.[0]
  if (num) { const j = get(`SELECT * FROM jobs WHERE job_number LIKE ?`, `%${num}`); if (j) return j }
  const q = `%${t.toLowerCase()}%`
  return get(`SELECT j.* FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id
    WHERE j.status='active' AND (lower(j.title) LIKE ? OR lower(COALESCE(c.name,'')) LIKE ?) ORDER BY j.id DESC LIMIT 1`, q, q)
}
const findInvoice = (token) => {
  const t = String(token).trim(); const num = t.match(/\d{3,}/)?.[0]
  if (num) { const i = get(`SELECT * FROM invoices WHERE invoice_number LIKE ?`, `%${num}`); if (i) return i }
  const q = `%${t.toLowerCase()}%`
  return get(`SELECT i.* FROM invoices i LEFT JOIN contacts c ON c.id=i.contact_id WHERE lower(COALESCE(c.name,'')) LIKE ? AND i.status NOT IN ('paid','void') ORDER BY i.id DESC LIMIT 1`, q)
}
const findEstimate = (token) => {
  const t = String(token).trim(); const num = t.match(/\d{3,}/)?.[0]
  if (num) { const e = get(`SELECT * FROM estimates WHERE estimate_number LIKE ?`, `%${num}`); if (e) return e }
  const q = `%${t.toLowerCase()}%`
  return get(`SELECT e.* FROM estimates e LEFT JOIN contacts c ON c.id=e.contact_id WHERE lower(COALESCE(c.name,'')) LIKE ? ORDER BY e.id DESC LIMIT 1`, q)
}

/* ---------- intents ---------- */

const reply = (text, extra = {}) => ({ reply: text, ...extra })

/** Draft an estimate from a plain-English order. Never sends or charges — that's the human's call. */
async function doQuote(msg) {
  // parseIntake always falls back to a default garment, so "quote" alone would draft junk.
  // Require a real signal: a quantity, or an explicit garment word in the message.
  const explicitGarment = /\b(tee|t-?shirt|shirt|hoodie|hoody|polo|tank|hat|cap|beanie|crew|apron|jersey|sweat)/i.test(msg)
  const order = await parseIntake(msg)
  const pieces = sizeTotal(order.sizes) || order.total_pieces || 0
  if (!pieces && !explicitGarment) return reply("Happy to quote — what and how many? e.g. “quote 48 navy hoodies, 2 color front, for Northgate”.")
  const qty = pieces || 48
  // Resolve a customer if one was named ("for <name>").
  const forMatch = msg.match(/\bfor ([A-Za-z][\w .'&-]{2,40})/)
  let contact = forMatch ? findContact(forMatch[1]) : null
  const s = getSettings()
  // priceIntake, not a second hand-rolled quoteScreenPrint call.
  //
  // This built its own price and wrote a bare "RUSH." onto the customer line while charging the
  // standard rate — v1.18.0 gave every automated path the rush surcharge and this one was still
  // computing its own number, so it stayed byte-identical for rush and non-rush. On 300 tees the
  // shop's own published 3-day tier makes a $2,447.00 quote $3,670.50: $1,223.50 given away, on
  // an estimate the assistant saves to the books with an estimate number spent.
  //
  // It also quoted every service as screen printing (a "Screen setup — 2 screens" line on an
  // embroidery quote), used a hardcoded $3.20 blank, and ignored the shop's price book. All of
  // that is what priceIntake is for. One expression, one answer, on every path.
  //
  // priceIntakeLive, not priceIntake: moving to priceIntake moved the $3.20 one function deeper
  // rather than removing it. With no `blank` passed, priceIntake falls back to order.garment_cost,
  // which comes from ai.mjs's TEN-ROW shortlist — and that shortlist's last rule matches any bare
  // "tee/shirt", so every one of the 43 garments in the shipped catalog that is not one of those
  // ten was priced at a Gildan's $3.20. Measured: "300 Comfort Colors 1717 tees, 2 color front"
  // quoted $2,870.00 here and $4,850.00 from Autopilot, the Slack quick-quote and "Read from
  // email" — all of which call priceIntakeLive. $1,980.00 of the same order, decided by which
  // panel the shop typed into, on an estimate this function SAVES to the books with a number
  // spent and a pipeline deal opened. The shop's own blank cost on that job is $1,950.00, 68% of
  // what the customer was billed, before a minute of press time.
  //
  // It costs nothing: blankCost() only reaches the network `if (supplierStatus(settings).connected)`
  // and otherwise drops straight through to the shop's own catalog. The timeout is explicit so a
  // connected-but-slow distributor cannot hold the chat panel open.
  const rate = taxRateFor(contact?.id)
  const priced = await priceIntakeLive({ ...order, sizes: Object.keys(order.sizes || {}).length ? order.sizes : { S: 0, M: qty, L: 0, XL: 0 }, total_pieces: qty }, s, { timeoutMs: 6000, taxRate: rate })
  const q = priced.quote
  const items = freezeUpcharges(priced.items)
  const t = priced.totals

  if (!contact) {
    // No known customer — hand back a ready-to-fill draft rather than inventing one.
    return reply(`Here's a draft: **${qty} ${order.garment}**, ${order.decoration.toLowerCase()}, at **${money(q.perPiece)}/pc** → **${money(t.total)}**${q.setup?.total > 0 ? ` (${q.setup.qty} × ${q.setup.label.toLowerCase()})` : ''}.\nWho's it for? Say “…for <customer>” and I'll save it, or open the editor to finish it.`,
      { cards: [{ icon: '▤', title: 'Open a blank estimate', sub: 'prefilled with this', href: '/estimates/new' }],
        prefill: { items, total: t.total } })
  }
  // Settings → Automation Modes → "Estimate drafting: Ask me first". Read nowhere until now, so
  // the switch saved, showed green and changed nothing. The draft is still handed back in full —
  // the same shape the no-customer branch above returns — it just is not written to the shop's
  // books, and no estimate number is spent, until a person finishes it.
  if (s.mode_estimates === 'manual') {
    return reply(`Here's a draft: **${qty} ${order.garment}**, ${order.decoration.toLowerCase()}, at **${money(q.perPiece)}/pc** → **${money(t.total)}** for **${contact.name}**.\nEstimate drafting is set to “Ask me first” in Settings, so I haven't saved it — open the editor to finish it.`,
      { cards: [{ icon: '▤', title: 'Open a blank estimate', sub: 'prefilled with this', href: '/estimates/new' }],
        prefill: { items, total: t.total, contact_id: contact.id } })
  }
  const num = nextEstimateNumber()
  const estId = Number(run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, tax_rate, notes, rush_days, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    contact.id, num, 'draft', JSON.stringify(items), t.subtotal, t.tax, t.total, rate, '', priced.rushDays || 0, now()).lastInsertRowid)
  logActivity('estimate', `Estimate ${num} drafted by the assistant — ${money(t.total)}`, { contact_id: contact.id })
  return reply(`Drafted **${num}** for **${contact.name}**: ${qty} ${order.garment} at ${money(q.perPiece)}/pc → **${money(t.total)}**. It's a draft — nothing sent.`,
    { cards: [{ icon: '▤', title: num, sub: `${money(t.total)} · review & send`, href: `/estimates/${estId}` }] })
}

function doOverdue() {
  const today = new Date().toISOString().slice(0, 10)
  const rows = all(`SELECT i.*, c.name AS cn FROM invoices i LEFT JOIN contacts c ON c.id=i.contact_id
    WHERE i.status NOT IN ('paid','void') AND i.due_date < ? ORDER BY (i.amount_due-i.amount_paid) DESC`, today)
  if (!rows.length) return reply("Nobody's overdue — everyone's paid on time.")
  const total = round2(rows.reduce((s, i) => s + (i.amount_due - i.amount_paid), 0))
  return reply(`**${money(total)}** overdue across ${rows.length} invoice${rows.length === 1 ? '' : 's'}, biggest first:`,
    { cards: rows.slice(0, 6).map((i) => ({ icon: '▣', title: `${i.invoice_number} · ${i.cn || ''}`, sub: `${money(i.amount_due - i.amount_paid)} · due ${i.due_date}`, href: `/invoices/${i.id}` })),
      // Every chip here has to be something this router can actually answer — clicking one posts
      // its exact text straight back to /api/assistant (public/js/views/assistant.js:68).
      followups: ['What has gone quiet?', "What's due this week?"] })
}

function doRevenue() {
  const monthStart = new Date().toISOString().slice(0, 8) + '01'
  const mtd = round2(get(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE date(created_at) >= ?`, monthStart).v)
  const out = round2(get(`SELECT COALESCE(SUM(amount_due-amount_paid),0) v FROM invoices WHERE status NOT IN ('paid','void')`).v)
  // COALESCE(subtotal, total), not total: SUM(total) counts sales tax as quoted revenue. The
  // dashboard KPI this line mirrors was corrected for exactly this, and the comment is still beside
  // it — "what the shop is chasing is what it keeps". The assistant kept quoting the taxed figure,
  // so the same question asked two ways gave two answers $247.50 apart.
  const open = round2(get(`SELECT COALESCE(SUM(COALESCE(subtotal, total)),0) v FROM estimates WHERE status IN ('draft','sent')`).v)
  return reply(`This month you've collected **${money(mtd)}**. There's **${money(out)}** outstanding on invoices and **${money(open)}** in quotes not yet approved.`,
    { cards: [{ icon: '◧', title: 'Open the dashboard', sub: 'the full picture', href: '/' }] })
}

function doDue(msg) {
  const week = /week/.test(msg)
  const end = week ? new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
  const rows = all(`SELECT j.*, c.name AS cn FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id
    WHERE j.status='active' AND j.due_date IS NOT NULL AND j.due_date <= ? ORDER BY j.rush DESC, j.due_date`, end)
  if (!rows.length) return reply(week ? 'Nothing due in the next 7 days — the floor is clear.' : 'Nothing due today — the floor is clear.')
  return reply(`${rows.length} job${rows.length === 1 ? '' : 's'} due ${week ? 'this week' : 'today'}${rows.some((j) => j.rush) ? ' (⚠ rush in there)' : ''}:`,
    { cards: rows.slice(0, 7).map((j) => ({ icon: j.rush ? '⚠' : '▦', title: `${j.title}`, sub: `${j.job_number} · ${j.cn || ''} · due ${j.due_date}`, href: `/jobs/${j.id}` })) })
}

function doProofs() {
  const rows = all(`SELECT a.*, j.id AS jid, j.job_number, j.title, c.name AS cn FROM art_versions a
    JOIN jobs j ON j.id=a.job_id LEFT JOIN contacts c ON c.id=j.contact_id WHERE a.status='sent' ORDER BY a.sent_at`)
  if (!rows.length) return reply('No proofs waiting on customers right now.')
  return reply(`${rows.length} proof${rows.length === 1 ? '' : 's'} sitting with customers — these block production:`,
    { cards: rows.map((a) => ({ icon: '◈', title: `${a.title} v${a.version}`, sub: `${a.cn || ''} · ${a.job_number}`, href: `/jobs/${a.jid}` })) })
}

function doBoard() {
  const rows = all(`SELECT stage, COUNT(*) c, COALESCE(SUM(json_extract(sizes,'$')),0) x FROM jobs WHERE status='active' GROUP BY stage`)
  const byStage = {}
  for (const r of all(`SELECT stage, COUNT(*) c FROM jobs WHERE status='active' GROUP BY stage`)) byStage[r.stage] = r.c
  const parts = Object.keys(STAGE_LABEL).filter((k) => byStage[k]).map((k) => `${byStage[k]} in ${STAGE_LABEL[k]}`)
  const total = Object.values(byStage).reduce((s, n) => s + n, 0)
  return reply(total ? `**${total} active job${total === 1 ? '' : 's'}** on the floor: ${parts.join(', ')}.` : 'The board is empty right now.',
    { cards: [{ icon: '▦', title: 'Open the job board', sub: 'drag to move', href: '/board' }] })
}

function doPipeline() {
  const open = all(`SELECT * FROM opportunities WHERE stage NOT IN ('won','lost')`)
  const won = get(`SELECT COUNT(*) c FROM opportunities WHERE stage='won'`).c
  const lost = get(`SELECT COUNT(*) c FROM opportunities WHERE stage='lost'`).c
  const val = round2(open.reduce((s, o) => s + (o.value || 0), 0))
  const rate = won + lost ? Math.round((won / (won + lost)) * 100) : null
  return reply(`**${money0(val)}** in ${open.length} open deal${open.length === 1 ? '' : 's'}${rate != null ? `, win rate **${rate}%**` : ''}.`,
    { cards: [{ icon: '◱', title: 'Open the pipeline', sub: 'drag between stages', href: '/pipeline' }] })
}

function doMoveJob(msg) {
  const m = msg.match(/move\s+(.+?)\s+(?:to|into)\s+(.+)/i)
  if (!m) return null
  const job = findJob(m[1])
  if (!job) return reply(`I couldn't find a job matching “${m[1].trim()}”. Try the job number.`)
  const stageKey = Object.keys(STAGE_WORDS).sort((a, b) => b.length - a.length).find((w) => m[2].toLowerCase().includes(w))
  const stage = stageKey && STAGE_WORDS[stageKey]
  if (!stage) return reply(`Which stage? One of: ${Object.values(STAGE_LABEL).join(', ')}.`)
  try { guardWorkflowStage(job.id,stage) } catch(e) { return reply(e.message) }
  const from = job.stage
  run(`UPDATE jobs SET stage=?, status=?, updated_at=? WHERE id=?`, stage, stage === 'complete' ? 'complete' : 'active', now(), job.id)
  // The fifth stage-writer, and the second that never stamped the ship date: "move JOB-1002 to
  // shipping" printed a packing slip 122 days stale. Same rule, same helper, from lib/db.mjs.
  stampShipDate(job, stage)
  logActivity('stage', `${job.job_number} moved to ${STAGE_LABEL[stage]} by the assistant`, { contact_id: job.contact_id, job_id: job.id })
  return reply(`Moved **${job.job_number}** (${job.title}) from ${STAGE_LABEL[from] || from} to **${STAGE_LABEL[stage]}**.`,
    { cards: [{ icon: '▦', title: job.job_number, sub: 'on the board', href: `/jobs/${job.id}` }],
      action: { done: true, undo: { type: 'job_stage', id: job.id, stage: from } } })
}

function doMarkPaid(msg) {
  // "record a payment of 1005 on INV-1003" used to pay INV-1005 in full: findInvoice grabbed the
  // first 3+ digit run — the dollar amount — as the invoice number, and the stated amount was
  // ignored entirely. So the wrong invoice was marked paid, for the wrong amount, and the invoice
  // the owner named was left untouched. Money moved against the wrong customer's account.
  //
  // Resolve the invoice from an EXPLICIT token first (INV-1003, or "invoice 1003"), and read a
  // stated amount separately so the two numbers can never be confused.
  const explicit = msg.match(/\bINV[-\s]?(\d{3,})/i)?.[1] || msg.match(/\binvoice\s*#?\s*(\d{3,})/i)?.[1]
  const amountStr = msg.match(/(?:\$|\bpayment of\s*|\bpaid\s*|\bamount\s*)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i)?.[1]
  const stated = amountStr ? round2(Number(amountStr.replace(/,/g, ''))) : null

  // If there's no explicit invoice token, only fall back to a bare-number match when the message
  // does not also contain a currency amount that would be misread as one.
  const inv = explicit
    ? get('SELECT * FROM invoices WHERE invoice_number LIKE ?', `%${explicit}`)
    : (stated == null ? findInvoice(msg) : null)
  if (!inv) {
    return reply(explicit
      ? `I couldn't find invoice ${explicit}.`
      : "Which invoice? Name it, e.g. “mark INV-1002 paid” or “record a payment of $250 on INV-1002”.")
  }
  /* A voided invoice is a cancelled demand, not a discounted one. POST /api/invoices/:id/payments
   * refuses this with a comment that spells out why — syncInvoiceStatus deliberately will not move
   * a void invoice, so the payment row exists, counts toward Revenue MTD and the customer's
   * lifetime value, and queues for QuickBooks, while the invoice itself still reads $0.00 paid and
   * CANCELLED. This door had no check at all, and answered "It's now paid in full." */
  if (inv.status === 'void') {
    return reply(`**${inv.invoice_number}** was voided — raise a new invoice before recording money against it.`,
      { cards: [{ icon: '▣', title: inv.invoice_number, sub: 'voided', href: `/invoices/${inv.id}` }] })
  }
  const bal = round2(inv.amount_due - inv.amount_paid)
  if (bal <= 0) return reply(`${inv.invoice_number} is already paid in full.`)

  // Honour the stated amount; a bare "mark paid" still means the whole balance. Never record more
  // than is owed — an overpayment through a chat command is far more likely a typo than a tip.
  let pay = stated == null ? bal : stated
  if (pay <= 0) return reply(`A payment has to be more than zero.`)
  let note = 'Recorded via assistant'
  if (pay > bal + 0.005) { pay = bal; note = `Recorded via assistant (capped at the ${money(bal)} balance)` }
  pay = round2(pay)

  /* The same cheque, recorded twice, is money the shop does not have.
   *
   * POST /api/invoices/:id/payments asks this question and has since round 18 — "two people at two
   * desks with the same cheque, one person on a phone and a laptop, or a re-click after a response
   * that never arrived". A chat panel is the same shop and the same cheque; it just had no guard
   * at all, and no over-payment ceiling to accidentally catch the doubled FULL payment either,
   * because a second `mark paid` finds a zero balance while a second `$500 of $1,000` does not.
   *
   * The route's escape is `confirm: true`; there is no such field on this wire, so the escape here
   * is words — and it has to exist, or the guard is a wall rather than a question. */
  const since = new Date(Date.now() - 120_000).toISOString().replace('T', ' ').slice(0, 19)
  const insisted = /\b(again|really|yes,? record|second payment)\b/i.test(msg)
  const dup = insisted ? null
    : get('SELECT id, amount, created_at FROM payments WHERE invoice_id = ? AND amount = ? AND created_at >= ? ORDER BY id DESC LIMIT 1', inv.id, pay, since)
  if (dup) {
    return reply(`${money(pay)} was already recorded on **${inv.invoice_number}** moments ago. If it really is a second payment, say “record a payment of ${money(pay)} on ${inv.invoice_number} again”.`,
      { cards: [{ icon: '▣', title: inv.invoice_number, sub: 'open the invoice', href: `/invoices/${inv.id}` }] })
  }

  run('INSERT INTO payments (invoice_id, amount, method, note, created_at) VALUES (?,?,?,?,?)', inv.id, pay, 'other', note, now())
  const updated = syncInvoiceStatus(inv.id)
  const newBal = round2(updated.amount_due - updated.amount_paid)
  logActivity('payment', `Payment ${money(pay)} on ${inv.invoice_number} (via assistant)`, { contact_id: inv.contact_id })
  // Everything the HTTP route does below its own INSERT: the order card, the shop's automations,
  // the invoice.paid webhook and the QuickBooks queue. All four live in server.mjs, which lib/
  // cannot import, so they are reached through the hook lib/db.mjs carries for exactly this.
  emitPaymentRecorded({ invoice_id: inv.id, before_status: inv.status })
  return reply(`Recorded ${money(pay)} on **${inv.invoice_number}**. ${newBal <= 0 ? 'It’s now paid in full.' : `Balance is now ${money(newBal)}.`}${pay < (stated ?? pay) ? ' (capped at the balance owed)' : ''}`,
    { cards: [{ icon: '▣', title: inv.invoice_number, sub: newBal <= 0 ? 'paid' : `${money(newBal)} left`, href: `/invoices/${inv.id}` }] })
}

function doSendEstimate(msg) {
  const e = findEstimate(msg)
  if (!e) return reply("I couldn't find that estimate. Try the estimate number.")
  if (e.status === 'approved') return reply(`${e.estimate_number} is already approved.`)
  return reply(`Ready to send **${e.estimate_number}** (${money(e.total)}) to the customer. Sending to a customer is a real message, so I left it for you to fire — one click on the estimate.`,
    { cards: [{ icon: '▤', title: e.estimate_number, sub: 'open & send', href: `/estimates/${e.id}` }] })
}

function doAddCustomer(msg) {
  const m = msg.match(/add (?:a )?(?:customer|client|contact)\s+(.+)/i)
  if (!m) return null
  const name = m[1].replace(/\bemail\b.*$/i, '').trim().replace(/[.,]$/, '')
  const email = msg.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] || ''
  if (!name) return reply('What name? e.g. “add customer Northgate Booster Club”.')
  const id = Number(run('INSERT INTO contacts (name, email, tags, created_at, updated_at) VALUES (?,?,?,?,?)', name, email, 'assistant', now(), now()).lastInsertRowid)
  logActivity('contact', `Customer added by the assistant — ${name}`, { contact_id: id })
  return reply(`Added **${name}**${email ? ` (${email})` : ''}.`, { cards: [{ icon: '◉', title: name, sub: 'open profile', href: `/contacts/${id}` }] })
}

function doFind(msg) {
  const m = msg.match(/(?:show|open|find|look ?up|pull up|who is|where'?s?)\s+(?:me\s+)?(.+)/i)
  const term = (m ? m[1] : msg).replace(/[?.]$/, '').trim()
  if (term.length < 2) return null
  const c = findContact(term)
  if (c) {
    // A VOIDED invoice is a cancelled demand, not a balance. With no status filter this told the
    // shop "Acme Co — $11,085 owed" while the contact record, the contact list, A/R aging, the
    // statement and the dashboard all read $5,542.40. doOverdue() four functions up has filtered
    // `status NOT IN ('paid','void')` all along. Lifetime keeps every payment actually received.
    const stats = get(`SELECT
        (SELECT COALESCE(SUM(amount_paid),0) FROM invoices WHERE contact_id=?) life,
        (SELECT COALESCE(SUM(amount_due-amount_paid),0) FROM invoices WHERE contact_id=? AND status NOT IN ('paid','void')) bal`,
      c.id, c.id)
    return reply(`**${c.name}**${c.company ? ` · ${c.company}` : ''} — ${money0(stats.life)} lifetime${stats.bal > 0 ? `, ${money0(stats.bal)} owed` : ''}.`,
      { cards: [{ icon: '◉', title: c.name, sub: 'open profile', href: `/contacts/${c.id}` }] })
  }
  const j = findJob(term)
  if (j) return reply(`**${j.title}** (${j.job_number}) is in ${STAGE_LABEL[j.stage] || j.stage}.`, { cards: [{ icon: '▦', title: j.job_number, sub: j.title, href: `/jobs/${j.id}` }] })
  return null
}

function doFollowups() {
  const stale = all(`SELECT e.*, c.name cn FROM estimates e LEFT JOIN contacts c ON c.id=e.contact_id WHERE e.status='sent' ORDER BY COALESCE(e.subtotal, e.total) DESC`)
  // dealValue: sales tax is the state's money, not what the shop is chasing. Same definition the
  // pipeline, the dashboard KPI and per-job profitability already use.
  const total = round2(stale.reduce((s, e) => s + dealValue(e), 0))
  if (!stale.length) return reply("No quotes are hanging — everyone's answered.")
  return reply(`**${money0(total)}** in quotes gone quiet, biggest first:`,
    { cards: stale.slice(0, 6).map((e) => ({ icon: '▤', title: `${e.estimate_number} · ${e.cn || ''}`, sub: money(dealValue(e)), href: `/estimates/${e.id}` })),
      followups: ["Who owes me money?", "What's due this week?"] })
}

const HELP = reply(
  "I'm your front desk. Just tell me what you need — for example:",
  { followups: ['Quote 48 navy hoodies, 2 color front, for Northgate', "Who owes me money?", "What's due this week?", 'Move JOB-1001 to production', 'How much did we make this month?', "What's the pipeline looking like?"] })

/* ---------- router ---------- */

/** Classify the message, run the matching tool. Deterministic first; model as a fallback. */
export async function ask(message) {
  const msg = String(message || '').trim()
  if (!msg) return HELP
  const m = msg.toLowerCase()

  // Actions (verbs) first — they're unambiguous.
  if (/\bmove\b.+\b(to|into)\b/.test(m)) { const r = doMoveJob(msg); if (r) return r }
  if (/\b(mark|record).+(paid|payment)\b|\bpaid\b.*inv/.test(m)) return doMarkPaid(msg)
  if (/\bsend\b.*(estimate|quote|est-?\d)/.test(m)) return doSendEstimate(msg)
  if (/\badd\b.+(customer|client|contact)\b/.test(m)) { const r = doAddCustomer(msg); if (r) return r }

  // A quantity + a garment word anywhere in the message is a quote ("48 hoodies",
  // "how much for 24 black tees"). They needn't be adjacent.
  const hasGarment = /\b(tee|t-?shirt|shirt|hoodie|hoody|polo|tank|hat|cap|beanie|crew|apron|jersey|sweat)/.test(m)
  if (/\b\d{1,4}\b/.test(m) && hasGarment) return await doQuote(msg)

  // How-to questions want guidance, not a quote. Route to the right page before any data intent.
  if (/\bhow (do|can|would) (i|we|you)\b|\bhow to\b|\bwhere (do|can|is)\b/.test(m)) {
    if (/pric|cost|markup|marg|rate|charge|upcharge|screen fee/.test(m))
      return reply('Set your prices on the Pricing page — blank markup, screen/setup fees, per-service rates and size upcharges all live there. The costing basics behind margin (hourly rate, utilization, spoilage) are in Settings → Shop & costing.', { followups: ["What's my margin on a job?", 'How much did we make this month?'] })
    if (/estimat|quote/.test(m))
      return reply('Fastest path: paste the customer\'s message into Autopilot and it drafts a priced estimate. Or open Estimates → New for a blank one.', { followups: ['Quote 24 black tees, 1 color front'] })
    if (/invoic|paid|payment|deposit|stripe/.test(m))
      return reply('Approve an estimate, then Convert it to an invoice. Connect your Stripe key in Settings to collect deposits and online payments into your own account.', {})
    if (/import|customer|contact/.test(m))
      return reply('Import your customer list from Settings (CSV), or add one by hand from Customers → Add.', {})
    if (/slack|distributor|s&s|sanmar|supplier|api key|ai/.test(m))
      return reply('Those connections live in Settings — Slack quoting, distributor accounts for live blank costs, and your own AI key each have a card there with copy-paste setup.', {})
    return HELP
  }

  // Questions (read-only) — money-owed and revenue-earned before the generic quote words,
  // so "how much did we make" isn't mistaken for "quote something".
  if (/\b(overdue|owe|owes|owed|past due|unpaid|collect)\b/.test(m)) return doOverdue()
  if (/\b(revenue|income|profit|sales|earn|made|make|making|bring|took in)\b/.test(m) && /\b(month|week|today|mtd|so far|this|year|much|money)\b/.test(m)) return doRevenue()
  if (/\b(quote|estimate|prices?|pricing|cost)\b/.test(m)) return await doQuote(msg)
  if (/\b(due|deadline|late)\b/.test(m)) return doDue(m)
  if (/\b(proof|art)\b.*(approv|waiting|out|pending)|waiting on (art|proof|customer)/.test(m)) return doProofs()
  if (/\b(board|floor|production|shop status|what.?s in|going on)\b/.test(m)) return doBoard()
  if (/\b(pipeline|deals|leads|win rate|opportunit)\b/.test(m)) return doPipeline()
  // `follow.?ups?` — plural. The assistant's OWN suggestion chips read "Show me all follow-ups"
  // and "Open all follow-ups", and `\bfollow.?up\b` does not match "follow-ups": the boundary
  // fails on the trailing s. Its own buttons fell through to the model, or to "I didn't catch
  // that one" on an install with no AI key.
  if (/\b(follow.?ups?|chase|quiet|stale)\b/.test(m)) return doFollowups()
  // Margin is a different question from revenue, and it has its own screen. Without this the
  // assistant's own "What's my margin on a job?" chip had nowhere to go.
  if (/\b(margin|markup|profitab)\w*\b/.test(m)) {
    return reply('Per-job margin lives on the **Profitability** screen — every job with its revenue, blank cost, decoration cost and the margin that falls out. The costing inputs behind it (hourly rate, utilization, spoilage) are in Settings → Shop & costing.',
      { followups: ['How much did we make this month?', "What's the pipeline looking like?"] })
  }
  if (/\b(help|what can you|commands|how do)\b/.test(m)) return HELP

  const find = doFind(msg)
  if (find) return find

  // Nothing matched — try the model if one is reachable, else be honest and offer help.
  const status = await aiStatus()
  if (status.available) {
    const draft = await draftReply({ contact: null, context: `A print-shop owner said: "${msg}". Answer helpfully and briefly as their front desk. If it needs an action, tell them which page to use.`, intent: 'assist' })
    if (draft.text) return reply(draft.text, { model: true })
  }
  return reply("I didn't catch that one. I can quote jobs, chase money, move jobs, and answer questions about the shop — tap a suggestion or try rephrasing.",
    { followups: ['Quote 24 black tees, 1 color front', "Who owes me money?", "What's due today?"] })
}
