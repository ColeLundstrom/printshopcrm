// Internal legacy callers express amounts in hundredths of the shop currency.
// Stripe's amount is in its currency-specific minor unit, not always hundredths.
const ZERO = new Set('BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF'.split(' '))
export const currencyCode = value => {
  const c=String(value || 'USD').toUpperCase()
  if(!/^[A-Z]{3}$/.test(c)) throw new Error('Invalid payment currency')
  return c
}
export const stripeScale = currency => {
  const c=currencyCode(currency)
  if(ZERO.has(c)) return 1
  if(c==='ISK' || c==='UGX') return 100
  return 10 ** new Intl.NumberFormat('en',{style:'currency',currency:c}).resolvedOptions().maximumFractionDigits
}
export function stripeUnits(hundredths,currency) {
  const c=currencyCode(currency), n=Number(hundredths)
  if(!Number.isSafeInteger(n) || n<=0) throw new Error('Payment amount must be positive whole hundredths')
  if((ZERO.has(c) || c==='ISK' || c==='UGX') && n%100) throw new Error(`${c} card payments require a whole currency amount`)
  const units=n*stripeScale(c)/100
  if(!Number.isSafeInteger(units)) throw new Error('Payment amount is not representable in this currency')
  return units
}
export function stripeHundredths(units,currency) {
  const n=Number(units), hundredths=n*100/stripeScale(currency)
  if(!Number.isSafeInteger(n) || n<0 || !Number.isSafeInteger(hundredths)) throw new Error('Invalid confirmed payment amount')
  return hundredths
}
