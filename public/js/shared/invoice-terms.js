export const INVOICE_TERM_FIELDS = ['due_date', 'po_number', 'billing_address', 'shipping_address']

const text = value => String(value ?? '')

export function invoiceTermsChanges(opening, form) {
  return Object.fromEntries(INVOICE_TERM_FIELDS
    .filter(field => text(form[field]) !== text(opening[field]))
    .map(field => [field, text(form[field])]))
}

export function invoiceTermsExpected(opening, changes) {
  return Object.fromEntries(Object.keys(changes).map(field => [field, text(opening[field])]))
}

export function invoiceTermsConflicts(current, changes, expected) {
  return INVOICE_TERM_FIELDS.filter(field => Object.hasOwn(changes, field)
    && text(current[field]) !== text(expected[field])
    && text(current[field]) !== text(changes[field]))
    .map(field => ({ field, current: text(current[field]) }))
}
