// Read-only report projections. Credits already reduce invoices.amount_due; subtracting them
// again here would understate receivables. Cash stays separate from these non-cash allowances.
const cents = n => Math.round(Number(n || 0) * 100)
const money = n => n / 100

export function receivableInvoice(invoice, creditTotals = new Map()) {
  return {
    id: invoice.id, number: invoice.invoice_number, contact_id: invoice.contact_id,
    contact_name: invoice.contact_name || 'Unknown', company: invoice.company || '',
    due_date: invoice.due_date, status: invoice.status,
    amount_due: money(cents(invoice.amount_due)), amount_paid: money(cents(invoice.amount_paid)),
    balance: money(cents(invoice.amount_due) - cents(invoice.amount_paid)),
    credit_total: money(creditTotals.get(invoice.id) || 0),
    payment_review: invoice.payment_review || '',
  }
}

export function collectionReview(invoices) {
  let due = 0, unpaused = 0, overpaid = 0, noBalance = 0
  const reviewed = []
  for (const invoice of invoices) {
    if (invoice.status === 'void') continue
    const balance = cents(invoice.balance)
    if (invoice.payment_review) {
      reviewed.push(invoice)
      due += Math.max(0, balance)
      overpaid += Math.max(0, -balance)
      if (balance <= 0) noBalance++
    } else unpaused += Math.max(0, balance)
  }
  return {
    due: money(due), unpaused_due: money(unpaused), count: reviewed.length,
    no_balance_count: noBalance, overpaid: money(overpaid), invoices: reviewed,
  }
}
