/**
 * Switcher presets for the customer CSV import. A preset is a list of case-insensitive header
 * aliases per contact field, plus a few "signature" headers used to recognise the export.
 *
 * The aliases come from the vendors' public help articles (Printavo "Customers" export under
 * My Account → Import/Export Data; YoPrint's customer CSV template under Sales → Customers). Those
 * articles do not publish a complete verbatim header list, so matching is deliberately alias-based
 * and tolerant of punctuation/spacing variants rather than claiming an exact column contract. The
 * shop can always change any choice in the mapper.
 *
 * Pure: no database, no I/O.
 */

/** Normalise a header for comparison: lowercase, collapse separators and punctuation (space _ - . : ? ( ) # /) to one space. */
export const normHeader = (h) => String(h ?? '').toLowerCase().replace(/[\s_\-.:?()#\/]+/g, ' ').trim()

// Address aliases repeated for billing and shipping. Printavo writes "Billing Address - Address 1"
// style headers in the customer export and "Billing Address1" / "Billing Zip" in Merch exports.
const printavoAddress = (kind) => {
  const k = kind === 'billing' ? 'billing' : 'shipping'
  return {
    [k + '_address']: [`${k} address address 1`, `${k} address 1`, `${k} address1`, `${k} street`, `${k} address street`, `${k} address`],
    [k + '_address_line2']: [`${k} address address 2`, `${k} address 2`, `${k} address2`],
    [k + '_city']: [`${k} address city`, `${k} city`],
    [k + '_region']: [`${k} address state`, `${k} state`, `${k} address province`, `${k} province`],
    [k + '_postal_code']: [`${k} address zip`, `${k} zip`, `${k} address zip code`, `${k} zip code`, `${k} address postal code`, `${k} postal code`],
    [k + '_country']: [`${k} address country`, `${k} country`],
  }
}
const yoprintAddress = (kind) => {
  const k = kind === 'billing' ? 'billing' : 'shipping'
  return {
    [k + '_address']: [`${k} address line 1`, `${k} address 1`, `${k} address1`, `${k} street`, `${k} address`],
    [k + '_address_line2']: [`${k} address line 2`, `${k} address 2`, `${k} address2`],
    [k + '_city']: [`${k} city`],
    [k + '_region']: [`${k} state`, `${k} province`],
    [k + '_postal_code']: [`${k} postcode`, `${k} zip`, `${k} postal code`],
    [k + '_country']: [`${k} country code`, `${k} country`],
  }
}

export const IMPORT_PRESETS = [
  { id: 'generic', label: 'Generic', short: 'Generic CSV', signature: [], minSignature: Infinity, aliases: {} },
  {
    id: 'printavo',
    label: 'Printavo customer export',
    short: 'Printavo export',
    // Two of these identify the Printavo customer export; generic spreadsheets rarely carry them.
    signature: ['customer id', 'tax resale no', 'tax exempt', 'billing address address 1', 'billing address city', 'shipping address address 1', 'shipping address city', 'owner name', 'owner email', 'default payment term', 'payment term days', 'billing address1', 'billing zip'],
    minSignature: 2,
    aliases: {
      // Printavo customers are companies with a primary contact: the person becomes the name and
      // the company is kept separately (mapContactRow falls back to the company when no person).
      name: ['full name', 'contact name', 'customer name'],
      first: ['first name', 'contact first name', 'firstname'],
      last: ['last name', 'contact last name', 'lastname'],
      email: ['email', 'contact email', 'email address', 'customer email'],
      phone: ['phone', 'contact phone', 'phone number', 'customer phone', 'mobile'],
      company: ['company', 'company name', 'customer'],
      notes: ['notes', 'customer notes', 'internal notes'],
      tags: ['tags'],
      ...printavoAddress('billing'),
      ...printavoAddress('shipping'),
    },
  },
  {
    id: 'yoprint',
    label: 'YoPrint customer export',
    short: 'YoPrint export',
    // YoPrint's customer CSV uses snake_case headers (customer_name, customer_tax_exempt,
    // billing_postcode, billing_country_code …). normHeader turns the underscores into spaces.
    signature: ['customer name', 'customer tax exempt', 'customer resale number', 'customer internal notes', 'customer website', 'billing postcode', 'billing country code', 'shipping postcode', 'shipping country code', 'contact email', 'contact first name'],
    minSignature: 2,
    aliases: {
      name: ['contact name', 'contact full name'],
      first: ['contact first name', 'first name'],
      last: ['contact last name', 'last name'],
      email: ['contact email', 'customer email', 'email'],
      phone: ['contact phone', 'contact phone number', 'contact mobile', 'customer phone', 'phone'],
      company: ['customer name', 'company', 'company name'],
      notes: ['customer internal notes', 'internal notes', 'notes'],
      tags: ['customer tags', 'tags'],
      ...yoprintAddress('billing'),
      ...yoprintAddress('shipping'),
    },
  },
]

const byId = Object.fromEntries(IMPORT_PRESETS.map(p => [p.id, p]))

/** Recognise a customer export from its header row. Returns the best preset (Generic when none). */
export function detectImportPreset(headers) {
  const set = new Set((headers || []).map(normHeader))
  let best = byId.generic, bestScore = 0
  for (const preset of IMPORT_PRESETS) {
    const score = preset.signature.filter(s => set.has(s)).length
    if (score >= preset.minSignature && score > bestScore) { best = preset; bestScore = score }
  }
  return { id: best.id, label: best.label, short: best.short, matched: bestScore }
}

/**
 * Field → header mapping for one preset. Fields the preset names are resolved ONLY from its
 * aliases (so a combined "Billing Address" never doubles up with the split columns); every other
 * field falls back to the generic synonym list. `synonyms` is the generic field → aliases table.
 */
export function presetMapping(presetId, headers, synonyms) {
  const preset = byId[presetId] || byId.generic
  const byNorm = new Map()
  for (const h of headers || []) { const n = normHeader(h); if (!byNorm.has(n)) byNorm.set(n, h) }
  const find = (aliases) => { for (const a of aliases) { const h = byNorm.get(normHeader(a)); if (h !== undefined) return h } return null }
  return Object.fromEntries(Object.entries(synonyms).map(([field, generic]) => [field,
    Object.hasOwn(preset.aliases, field) ? find(preset.aliases[field]) : (generic.find(h => (headers || []).includes(h)) ?? null),
  ]))
}
