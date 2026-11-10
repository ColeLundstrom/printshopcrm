/**
 * QuickBooks Online: the setup and status half, plus the Xero export.
 *
 * The push itself (customers, invoices, payments, the queue and its retry/dismiss routes) lives in
 * server.mjs and predates this file. What was missing was any way for a shop to USE it: no screen
 * took the Intuit app keys, nothing said which company was connected or when it last synced, and a
 * lapsed sign-in failed silently one row at a time. These routes are what the Books card talks to.
 *
 * One-way by design: PrintShopCRM → QuickBooks. Nothing here reads the books back into the shop.
 */
import { all, get, run, now, getSettings, setSetting, applySettingsPatch, localDateOf, lineAmount, lineQty, getUpcharges, round2 } from './db.mjs'
import { TAX_ITEM_NAME, TAX_ACCOUNT_NAME } from './quickbooks.mjs'

const CLIENT_ID = /^[A-Za-z0-9_-]{10,200}$/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** Xero's sales-invoice import template, in its column order. Starred columns are required by Xero. */
export const XERO_COLUMNS = ['*ContactName', 'EmailAddress', 'POAddressLine1', 'POAddressLine2', 'POAddressLine3', 'POAddressLine4',
  'POCity', 'PORegion', 'POPostalCode', 'POCountry', '*InvoiceNumber', 'Reference', '*InvoiceDate', '*DueDate', 'Total',
  'InventoryItemCode', '*Description', '*Quantity', '*UnitAmount', 'Discount', '*AccountCode', '*TaxType', 'TaxAmount',
  'TrackingName1', 'TrackingOption1', 'TrackingName2', 'TrackingOption2', 'Currency', 'BrandingTheme']

const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d } catch { return d } }
const cents = (n) => Math.round((Number(n) || 0) * 100)

/**
 * One invoice as Xero rows: a row per line, the invoice's tax spread over its taxable lines to the
 * cent. Exported for the unit test — this is arithmetic a bookkeeper will import into real books.
 */
export function xeroRowsForInvoice(inv, { items, tax, upcharges, dateFmt, accountCode, taxType, exemptType, currency }) {
  const fmt = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return !m ? '' : dateFmt === 'dmy' ? `${m[3]}/${m[2]}/${m[1]}` : `${m[2]}/${m[3]}/${m[1]}` }
  let lines = (Array.isArray(items) ? items : []).map((it) => {
    const amount = round2(lineAmount(it, upcharges)), qty = Number(lineQty(it)) || 1
    // Quantity × UnitAmount must reproduce the line to the cent in Xero. A size grid with per-size
    // upcharges often cannot be expressed as one unit price; that line goes over as a single unit.
    const unit = Math.round((amount / qty) * 10000) / 10000
    const exact = qty > 0 && Math.abs(round2(unit * qty) - amount) < 0.005
    return { description: [it.description, it.detail].filter(Boolean).join(' — ') + (exact || qty === 1 ? '' : ` (${qty} pcs)`),
      qty: exact ? qty : 1, unit: exact ? unit : amount, amount, taxable: it.taxable !== false }
  }).filter((l) => l.description || l.amount)
  const total = cents(inv.amount_due), taxC = Math.max(0, cents(tax))
  const lineSum = lines.reduce((n, l) => n + cents(l.amount), 0)
  // The invoice is the truth. Lines that do not add up to it (an imported or adjusted invoice) are
  // replaced by one line for the pre-tax amount rather than exported as a document that disagrees.
  if (!lines.length || lineSum + taxC !== total) {
    const preTax = Math.max(0, total - taxC)
    lines = [{ description: `Invoice ${inv.invoice_number}`, qty: 1, unit: preTax / 100, amount: preTax / 100, taxable: taxC > 0 }]
  }
  return rowsOut(inv, lines, taxC, { fmt, accountCode, taxType, exemptType, currency })
}

function rowsOut(inv, lines, taxC, { fmt, accountCode, taxType, exemptType, currency }) {
  const taxable = lines.filter((l) => l.taxable && l.amount > 0)
  const base = taxable.reduce((n, l) => n + cents(l.amount), 0)
  let left = taxable.length && base > 0 ? taxC : 0
  const shares = new Map()
  taxable.forEach((l, i) => { const share = i === taxable.length - 1 ? left : Math.round(taxC * cents(l.amount) / base); shares.set(l, share); left -= share })
  return lines.map((l) => {
    const t = shares.get(l) || 0
    return {
      '*ContactName': inv.company || inv.contact_name || 'Customer', EmailAddress: inv.email || '',
      '*InvoiceNumber': inv.invoice_number, Reference: inv.po_number || '',
      '*InvoiceDate': fmt(localDateOf(inv.created_at)), '*DueDate': fmt(inv.due_date || localDateOf(inv.created_at)),
      Total: (cents(inv.amount_due) / 100).toFixed(2),
      '*Description': l.description || `Invoice ${inv.invoice_number}`, '*Quantity': String(l.qty), '*UnitAmount': String(l.unit),
      '*AccountCode': accountCode, '*TaxType': t > 0 ? taxType : exemptType, TaxAmount: (t / 100).toFixed(2), Currency: currency,
    }
  })
}

export function registerQuickbooksRoutes(app, { requireRole, hasRole, wrap, publicOrigin, processQboQueue, qboConnected, csvCell, logActivity }) {
  const redirectUri = (req) => `${publicOrigin(req)}/api/qbo/callback`

  /** Everything the card needs, and nothing secret: flags for the keys, never the keys. */
  app.get('/api/qbo/status', requireRole('manager'), wrap((req, res) => {
    const s = getSettings()
    const count = (where) => get(`SELECT COUNT(*) AS n FROM qbo_sync WHERE ${where}`).n
    res.json({
      direction: 'one_way_push',
      can_configure: hasRole(req, 'owner'),
      client_id: s.qbo_client_id || '',
      client_secret_set: !!s.qbo_client_secret,
      environment: s.qbo_environment === 'sandbox' ? 'sandbox' : 'production',
      redirect_uri: redirectUri(req),
      connected: qboConnected(),
      needs_reconnect: qboConnected() && !!s.qbo_needs_reconnect,
      company_name: s.qbo_company_name || '',
      realm_id: s.qbo_realm_id || '',
      last_sync_at: s.qbo_last_sync_at || '',
      autosync: s.qbo_autosync !== 'off',
      tax_mode: s.qbo_tax_mode === 'income_line' ? 'income_line' : 'liability',
      tax_item: TAX_ITEM_NAME, tax_account: TAX_ACCOUNT_NAME,
      counts: { ok: count("status = 'ok'"), open: count("status IN ('pending','retrying','syncing')"), failed: count("status = 'failed'"), manual: count("status = 'manual'") },
    })
  }))

  /**
   * Save the shop's own Intuit app keys (bring-your-own, like every other integration here), the
   * environment, and the two sync preferences. Owner-only. An empty secret means "unchanged".
   */
  app.put('/api/qbo/credentials', requireRole('owner'), wrap((req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const cur = getSettings()
    const patch = {}
    if (b.client_id !== undefined) {
      const id = String(b.client_id ?? '').trim()
      if (!CLIENT_ID.test(id)) return res.status(400).json({ code: 'qbo_client_id_invalid', error: 'That does not look like an Intuit Client ID. Copy it from your app’s Keys & credentials page.' })
      patch.qbo_client_id = id
    }
    if (b.client_secret !== undefined && String(b.client_secret ?? '').trim() !== '') {
      const secret = String(b.client_secret).trim()
      if (secret.length < 10 || secret.length > 200 || /\s/.test(secret)) return res.status(400).json({ code: 'qbo_client_secret_invalid', error: 'That does not look like an Intuit Client Secret. Copy it from your app’s Keys & credentials page.' })
      patch.qbo_client_secret = secret
    }
    if (b.environment !== undefined) {
      if (!['production', 'sandbox'].includes(b.environment)) return res.status(400).json({ error: 'Choose production or sandbox.' })
      patch.qbo_environment = b.environment
    }
    if (b.autosync !== undefined) patch.qbo_autosync = b.autosync === false || b.autosync === 'off' ? 'off' : 'on'
    if (b.tax_mode !== undefined) {
      if (!['liability', 'income_line'].includes(b.tax_mode)) return res.status(400).json({ error: 'Choose how sales tax is posted.' })
      patch.qbo_tax_mode = b.tax_mode
    }
    // Keys or environment that no longer match the tokens on file cannot keep using them: a
    // production token is refused by the sandbox, and another app's keys cannot refresh it.
    const rekeyed = (patch.qbo_client_id && patch.qbo_client_id !== cur.qbo_client_id) || !!patch.qbo_client_secret
      || (patch.qbo_environment && patch.qbo_environment !== (cur.qbo_environment || 'production'))
    applySettingsPatch(patch)
    if (rekeyed && qboConnected()) { setSetting('qbo_needs_reconnect', '1'); setSetting('qbo_tax_item_id', '') }
    if (rekeyed) logActivity('note', 'QuickBooks app keys or environment changed', {})
    res.json({ ok: true, needs_reconnect: rekeyed && qboConnected() })
  }))

  /** Push everything that is waiting, now, instead of on the next five-minute sweep. */
  app.post('/api/qbo/sync-now', requireRole('manager'), wrap(async (_req, res) => {
    if (!qboConnected()) return res.status(400).json({ code: 'qbo_not_connected', error: 'QuickBooks Online is not connected yet.' })
    run("UPDATE qbo_sync SET next_attempt_at = ? WHERE status IN ('pending','retrying')", now())
    const waiting = get("SELECT COUNT(*) AS n FROM qbo_sync WHERE status IN ('pending','retrying')").n
    const synced = await processQboQueue(25, { force: true })
    const s = getSettings()
    res.json({ ok: true, synced, waiting: Math.max(0, waiting - synced), needs_reconnect: !!s.qbo_needs_reconnect })
  }))

  /** Put every failed row back on the queue with a clean slate. Rows that need a person stay put. */
  app.post('/api/qbo/queue/retry-failed', requireRole('manager'), wrap((_req, res) => {
    const r = run("UPDATE qbo_sync SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ? WHERE status = 'failed'", now(), now())
    res.json({ ok: true, requeued: Number(r.changes || 0) })
  }))

  /**
   * Export for Xero — a FILE, not a sync. Invoices in Xero's sales-invoice import layout, for the
   * dates given (shop calendar). Xero imports them as drafts for the bookkeeper to approve.
   */
  app.get('/api/xero/invoices.csv', requireRole('manager'), wrap((req, res) => {
    const day = (v) => (ISO_DAY.test(String(v || '')) ? String(v) : '')
    const from = day(req.query.from), to = day(req.query.to)
    const s = getSettings()
    const clean = (v, d, max = 60) => { const t = String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max); return t || d }
    const opts = {
      upcharges: getUpcharges(), currency: s.currency || 'USD',
      dateFmt: req.query.date === 'dmy' || req.query.date === 'mdy' ? req.query.date : (/^en-US/i.test(s.locale || 'en-US') ? 'mdy' : 'dmy'),
      accountCode: clean(req.query.account, '200', 20), taxType: clean(req.query.tax, 'Tax on Sales'), exemptType: clean(req.query.exempt, 'Tax Exempt'),
    }
    const out = [XERO_COLUMNS.map(csvCell).join(',')]
    for (const inv of all(`SELECT i.*, c.name AS contact_name, c.company, c.email, e.items AS est_items, e.subtotal AS est_subtotal, e.tax AS est_tax
        FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id LEFT JOIN estimates e ON e.id = i.estimate_id
        WHERE i.status != 'void' AND i.imported_at IS NULL ORDER BY i.id`)) {
      const local = localDateOf(inv.created_at)
      if ((from && local < from) || (to && local > to)) continue
      // Tax is split out only when it is KNOWN — the quote's subtotal + tax still equals the invoice.
      const known = inv.est_subtotal != null && cents(inv.est_subtotal) + cents(inv.est_tax) === cents(inv.amount_due)
      const rows = xeroRowsForInvoice(inv, { ...opts, items: known ? parse(inv.est_items, []) : [], tax: known ? inv.est_tax : 0 })
      for (const row of rows) out.push(XERO_COLUMNS.map((c) => csvCell(row[c] ?? '')).join(','))
    }
    res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="printshopcrm-xero-invoices${from || to ? `-${from || 'start'}-to-${to || 'today'}` : ''}.csv"`)
    res.send(out.join('\r\n') + '\r\n')
  }))
}
