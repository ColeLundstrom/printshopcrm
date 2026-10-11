export const PAYMENT_TERMS = Object.freeze({
  due_on_receipt: 0,
  net_15: 15,
  net_30: 30,
  net_45: 45,
})

export function paymentTerm(value) {
  if (typeof value !== 'string' || !Object.hasOwn(PAYMENT_TERMS, value))
    throw Object.assign(new Error('Choose Due on receipt, Net 15, Net 30, or Net 45.'), { status: 400, code: 'invalid_payment_term', expose: true })
  return value
}

export function paymentDueDate(term, today) {
  const days = PAYMENT_TERMS[paymentTerm(term)]
  const date = new Date(`${today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function initPaymentTermsSchema(db) {
  if (!db.prepare('PRAGMA table_info(contacts)').all().some(c => c.name === 'payment_term'))
    db.exec("ALTER TABLE contacts ADD COLUMN payment_term TEXT NOT NULL DEFAULT 'net_15'")
}
