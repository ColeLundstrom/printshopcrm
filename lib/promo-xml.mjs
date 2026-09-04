import { XMLParser, XMLValidator } from 'fast-xml-parser'
const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  ignoreAttributes: true,
  processEntities: true
})
export function parsePromoXml(text) {
  if (typeof text !== 'string' || text.length > 4e6 || /<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error('Invalid PromoStandards XML')
  if (XMLValidator.validate(text) !== true) throw new Error('Invalid PromoStandards XML')
  const parsed = parser.parse(text),
    body = parsed.Envelope?.Body
  if (!body || typeof body !== 'object') throw new Error('Supplier did not return a SOAP response')
  if (body.Fault) throw new Error('Supplier returned a SOAP fault. Check service access and request fields.')
  const check = (v) => {
    if (!v || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v)) {
      if (['ErrorMessage', 'ServiceMessage'].includes(k)) {
        for (const e of Array.isArray(x) ? x : [x]) {
          if (e?.code !== undefined && Number(e.code) !== 0)
            throw new Error(`PromoStandards error ${/^\d{1,6}$/.test(e.code) ? e.code : 'reported'}`)
        }
      }
      check(x)
    }
  }
  check(body)
  return body
}
