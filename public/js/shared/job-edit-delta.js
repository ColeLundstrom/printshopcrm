// Keep the form's opening values as the editing baseline. Another teammate may change a job
// while this dialog is open; sending every prefilled field would write those newer values back.
const TEXT_FIELDS = ['title', 'decoration', 'quantities', 'garment', 'due_date', 'assigned_to', 'shipping_address', 'notes']

export function changedJobFields(original, form) {
  const changed = {}
  for (const key of TEXT_FIELDS) {
    const before = String(original?.[key] ?? (key === 'decoration' ? 'Screen Print' : ''))
    const after = String(form[key] ?? '')
    if (after !== before) changed[key] = form[key]
  }
  if (Boolean(form.rush) !== Boolean(original?.rush)) changed.rush = Boolean(form.rush)
  return changed
}
