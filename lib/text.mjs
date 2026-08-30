/* Small text helpers shared by all three parsers in this product. No imports, so nothing cycles. */

/* -------------------------------------------------------------------------------------------------
 * Contact details, taken out of the sentence before anything counts the numbers in it.
 *
 * Both parsers in this product allow a short gap between a number and its unit noun, because a
 * colour or two ordinarily sits between them ("24 black tees"). That gap is also, exactly, the
 * width of the rest of a phone number: "call us at 714-555-1234 about 48 tees" was quoted at 714
 * pieces, and "reach me at 949.555.0117, we need 24 hoodies" at 117. On the receptionist that
 * number is spoken to an anonymous stranger and written to a numbered draft estimate; on
 * /api/autopilot in Full Auto nothing holds it, because the deterministic parser and the model
 * agree, so the wrong quote is mailed to the customer and a job is booked against it.
 *
 * The style-number scrub for the same class of bug already landed; the phone scrub never did.
 * ---------------------------------------------------------------------------------------------- */

const EMAIL_SPAN = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}/g
const PHONE_SPAN = /\+?\(?\d[\d\s().-]{8,32}\d/g

/**
 * The first thing in `text` that has the SHAPE of a phone number, or null.
 *
 * The old test was "ten or more digits with punctuation between them", which is also true of a
 * size run and of a pair of dates: "sizes are 24 12 36 48 60 72" and "by 2026-09-08 2026-10-12"
 * were both stored as the visitor's phone number, and because nextQuoteGoal treats a phone as
 * "we can reach them", the lead was captured as contactable when it was not — and the shop was
 * told the bot had collected their details.
 *
 * Real numbers, US and international, all still pass: E.164 caps a number at 15 digits, no phone
 * is written as six separate numbers in a row, and every phone has a subscriber part of three or
 * more digits. A size run is nothing but two-digit groups; a date carries an ISO run.
 */
export function phoneCandidate(text) {
  for (const m of String(text || '').matchAll(PHONE_SPAN)) {
    const s = m[0]
    if (/\d{4}-\d{2}-\d{2}/.test(s)) continue // an ISO date, or two of them
    const groups = s.match(/\d+/g) || []
    const digits = groups.join('').length
    if (digits < 10 || digits > 15) continue
    if (groups.length > 5) continue
    if (!groups.some((g) => g.length >= 3)) continue
    return s.trim()
  }
  return null
}

/**
 * The message with every span that is never a piece count taken out — the email address, the
 * phone numbers, and the dates. A date is the same trap as a phone: "need them by 2026-09-08
 * 2026-10-12 for 200 tees" read the 08 out of the first date and quoted EIGHT pieces, because
 * "2026-10-12 for " fits inside the gap the pattern allows between a count and its noun.
 * The due date is parsed from the untouched text, so nothing is lost by removing it here.
 */
export function countableText(text) {
  let t = String(text || '').replace(EMAIL_SPAN, ' ')
  // A signature block can carry a desk line and a mobile; four is well past anything real.
  for (let i = 0; i < 4; i++) {
    const p = phoneCandidate(t)
    if (!p) break
    t = t.split(p).join(' ')
  }
  return t.replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ').replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
}
