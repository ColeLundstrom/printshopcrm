/**
 * How an amount is written — imported by BOTH the browser (as a module URL) and the server (as a
 * file path), the same way pricing.js is. One source of truth: the total a customer sees on screen
 * is spelled the way it is on their PDF, in the email, on the pay page and in the assistant.
 *
 * Until this existed, money was formatted as `'$' + n.toLocaleString('en-US')` in nine separate
 * places — core.js, pdf.mjs, agent.mjs, assistant.mjs, quickquote.mjs, slack.mjs, automations.mjs,
 * server.mjs and the gang-sheet embed — and dates as `toLocaleDateString('en-US')` in three more.
 * A shop in Manchester, Toronto, Berlin or Sydney saw `$` on every screen and every document it
 * gave a customer, with no setting that could change it. On an invoice that is not cosmetic.
 *
 * The shop chooses a currency (ISO 4217) and a locale (BCP 47) once, in Settings. Both default to
 * what the app has always done, so an existing install prints byte-for-byte what it printed before.
 * Anything unrecognised falls back to the default rather than throwing — a formatter that can
 * crash a PDF over a typo in a settings row is worse than one that prints dollars.
 *
 * One shop, one currency. Per-customer currencies and exchange rates are deliberately out of scope.
 */

export const DEFAULT_CURRENCY = 'USD'
export const DEFAULT_LOCALE = 'en-US'

// The currencies this runtime actually knows. Intl accepts ANY three letters as "well-formed" —
// `currency: 'ABC'` formats as "ABC 5.00" without complaint — so the shape check alone would let a
// typo through to every invoice. supportedValuesOf is Node 18+ / every current browser; where it
// is missing, well-formed is the best that can be checked.
const KNOWN_CURRENCIES = typeof Intl.supportedValuesOf === 'function' ? new Set(Intl.supportedValuesOf('currency')) : null

/** An ISO 4217 code this runtime can format: 'USD', 'EUR', 'GBP' — not 'usd', not 'US$', not 'ABC'. */
export function isCurrencyCode(code) {
  const c = String(code || '')
  if (!/^[A-Z]{3}$/.test(c)) return false
  if (KNOWN_CURRENCIES) return KNOWN_CURRENCIES.has(c)
  try { new Intl.NumberFormat('en', { style: 'currency', currency: c }); return true } catch { return false }
}

/**
 * A locale tag Intl has data for: 'en-US', 'fr-CA', 'de', 'pt-BR'. Not 'en_US' (wrong separator),
 * and not 'american' — which is syntactically a valid eight-letter language subtag, so
 * getCanonicalLocales passes it and NumberFormat then silently falls back to whatever the runtime's
 * default locale is. supportedLocalesOf is the check that asks whether the data is really there.
 */
export function isLocale(tag) {
  const s = String(tag || '').trim()
  if (!s) return false
  try { return Intl.NumberFormat.supportedLocalesOf([s]).length === 1 } catch { return false }
}

/**
 * Currencies offered in the Settings picker. Any ISO code Intl knows works; this is just the list a
 * shop is likely to want without typing it. Ordered by how often a print shop is in that country.
 */
export const CURRENCY_CHOICES = [
  'USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD', 'MXN', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK',
  'ZAR', 'INR', 'BRL', 'SGD', 'HKD', 'AED', 'PHP', 'THB', 'MYR', 'IDR', 'KRW', 'TRY', 'ILS',
]

/** Locales offered in the Settings picker, as [tag, label]. Any BCP 47 tag works; these are the common ones. */
export const LOCALE_CHOICES = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-CA', 'English (Canada)'],
  ['fr-CA', 'Français (Canada)'],
  ['en-AU', 'English (Australia)'],
  ['en-NZ', 'English (New Zealand)'],
  ['en-IE', 'English (Ireland)'],
  ['de-DE', 'Deutsch'],
  ['fr-FR', 'Français'],
  ['es-ES', 'Español (España)'],
  ['es-MX', 'Español (México)'],
  ['nl-NL', 'Nederlands'],
  ['it-IT', 'Italiano'],
  ['pt-BR', 'Português (Brasil)'],
  ['sv-SE', 'Svenska'],
  ['da-DK', 'Dansk'],
  ['nb-NO', 'Norsk'],
  ['pl-PL', 'Polski'],
  ['ja-JP', '日本語'],
  ['en-IN', 'English (India)'],
  ['en-ZA', 'English (South Africa)'],
  ['en-SG', 'English (Singapore)'],
]

// Every character the PDF renderer can draw: Helvetica with WinAnsiEncoding, emitted as latin-1,
// plus the euro sign, which WinAnsi carries at 0x80 and lib/pdf.mjs maps there. A currency symbol
// outside this set (₹, ₩, ₪, zł) would print as '?', so the PDF formatter spells those currencies
// by ISO code instead — "INR 1,234.50" is honest; "? 1,234.50" is a document the shop cannot send.
const LATIN1_PLUS_EURO = /^[\x20-\x7E\xA0-\xFF€]*$/

const CACHE = new Map()

/**
 * The formatter for a shop. `currency` and `locale` come from its settings; both are optional and
 * both are validated here, so callers pass whatever the settings row holds and never think about it.
 *
 *   money(n)       → "$1,234.50"    "-$40.00"    "1.234,50 €"    "£1,234.50"    "¥1,235"
 *   money0(n)      → "$1,235"       whole units, for dashboards and tiles
 *   moneyShort(n)  → "$2" / "$2.50" up to the currency's own precision, for compact labels
 *   number(n)      → "1,234"        a plain count in the same locale
 *   symbol         → "$" / "€" / "£" — for labels like "Shop rate ($/hr)"
 *   currency, locale — what was actually resolved after validation
 *
 * `charset: 'latin1'` is for the PDF renderer, whose font cannot draw every symbol (see above).
 *
 * Formatters are cached per (locale, currency, charset): Intl.NumberFormat construction costs more
 * than a whole dashboard's worth of formatting calls, and money() is called in loops.
 */
export function moneyFormatter({ currency, locale, charset } = {}) {
  const cur = isCurrencyCode(currency) ? currency : DEFAULT_CURRENCY
  const loc = isLocale(locale) ? locale : DEFAULT_LOCALE
  const key = `${loc}|${cur}|${charset || ''}`
  const hit = CACHE.get(key)
  if (hit) return hit

  const base = { style: 'currency', currency: cur }
  let full = new Intl.NumberFormat(loc, base)
  const symbolOf = (f) => f.formatToParts(0).find((p) => p.type === 'currency')?.value ?? cur
  if (charset === 'latin1' && !LATIN1_PLUS_EURO.test(symbolOf(full))) {
    base.currencyDisplay = 'code'
    full = new Intl.NumberFormat(loc, base)
  }
  const digits = full.resolvedOptions().maximumFractionDigits
  const whole = new Intl.NumberFormat(loc, { ...base, minimumFractionDigits: 0, maximumFractionDigits: 0 })
  const plain = new Intl.NumberFormat(loc)

  // Never NaN, never Infinity, and never negative zero: `-$0.00` on a paid-in-full invoice is the
  // kind of thing a customer phones about.
  const num = (n) => { const v = Number(n); if (!Number.isFinite(v)) return 0; return Object.is(v, -0) ? 0 : v }

  const f = {
    currency: cur,
    locale: loc,
    symbol: symbolOf(full),
    money: (n) => full.format(num(n)),
    // Math.round first, then format: Intl rounds half away from zero, Math.round rounds half up,
    // and this is what the previous money0 did. Keeping the rounding keeps every dashboard tile.
    money0: (n) => whole.format(num(Math.round(num(n)))),
    // "$2" for a whole amount, "$2.50" otherwise — a minimum of 0 fraction digits with a maximum of
    // the currency's own would print "$2.5", which no price tag has ever said.
    moneyShort: (n) => { const v = num(n); return Number.isInteger(v) ? whole.format(v) : full.format(v) },
    number: (n) => plain.format(num(n)),
  }
  CACHE.set(key, f)
  return f
}
