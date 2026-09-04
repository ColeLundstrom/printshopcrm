import crypto from 'node:crypto'

export const authorizeConfigured = s => !!(String(s?.anet_login_id || '').trim() && String(s?.anet_transaction_key || '').trim() && /^[a-f0-9]{128}$/i.test(String(s?.anet_signature_key || '')))
export const authorizeEndpoint = s => s?.anet_environment === 'live' ? 'https://api.authorize.net/xml/v1/request.api' : 'https://apitest.authorize.net/xml/v1/request.api'
export const authorizeFormUrl = s => s?.anet_environment === 'live' ? 'https://accept.authorize.net/payment/payment' : 'https://test.authorize.net/payment/payment'

async function request(settings,method,body,send=fetch) {
  if(!String(settings?.anet_login_id || '').trim() || !settings?.anet_transaction_key) throw new Error('Enter the Authorize.net API Login ID and Transaction Key before testing.')
  const r=await send(authorizeEndpoint(settings),{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),redirect:'error',body:JSON.stringify({[method]:{merchantAuthentication:{name:settings.anet_login_id,transactionKey:settings.anet_transaction_key},...body}})})
  const text=await r.text(); let d
  try {d=JSON.parse(text.replace(/^\uFEFF/,''))} catch {throw new Error(`Authorize.net did not return a valid reply (HTTP ${r.status})`)}
  if(!r.ok || d?.messages?.resultCode !== 'Ok') throw new Error(`Authorize.net: ${d?.messages?.message?.[0]?.text || 'connection failed'}`)
  return d
}
export async function testAuthorize(settings,send=fetch) {
  const d=await request(settings,'authenticateTestRequest',{},send)
  return {ok:d.messages.resultCode==='Ok',environment:settings.anet_environment === 'live' ? 'live' : 'sandbox'}
}
export async function createAuthorizeCheckout({settings,amountCents,reference,successUrl,cancelUrl,customerEmail,currency='USD',send=fetch}) {
  // Authorize.net settles in the merchant account's currency. Require an explicit matching setting.
  if(String(currency).toUpperCase() !== String(settings.anet_currency || 'USD').toUpperCase()) throw new Error('Shop currency must match the Authorize.net merchant-account currency')
  if(!Number.isSafeInteger(amountCents) || amountCents<=0 || !/^[A-Za-z0-9_-]{20}$/.test(reference)) throw new Error('Invalid checkout amount or reference')
  const d=await request(settings,'getHostedPaymentPageRequest',{
    transactionRequest:{transactionType:'authCaptureTransaction',currencyCode:String(currency).toUpperCase(),amount:(amountCents/100).toFixed(2),order:{invoiceNumber:reference,description:'PrintShopCRM invoice payment'},...(customerEmail ? {customer:{email:customerEmail}} : {})},
    hostedPaymentSettings:{setting:[
      {settingName:'hostedPaymentReturnOptions',settingValue:JSON.stringify({showReceipt:true,url:successUrl,urlText:'Return to shop',cancelUrl,cancelUrlText:'Cancel'})},
      {settingName:'hostedPaymentPaymentOptions',settingValue:JSON.stringify({cardCodeRequired:true,showCreditCard:true,showBankAccount:false})},
      {settingName:'hostedPaymentCustomerOptions',settingValue:JSON.stringify({showEmail:true,requiredEmail:false,addPaymentProfile:false})},
    ]},
  },send)
  if(typeof d.token !== 'string' || !d.token) throw new Error('Authorize.net did not return a checkout token')
  return {token:d.token,formUrl:authorizeFormUrl(settings)}
}
export async function retrieveAuthorizeTransaction({settings,transactionId,send=fetch}) {
  if(!/^\d{1,30}$/.test(String(transactionId))) throw new Error('Invalid Authorize.net transaction ID')
  const d=await request(settings,'getTransactionDetailsRequest',{transId:String(transactionId)},send)
  const t=d.transaction
  if(!t || String(t.transId)!==String(transactionId)) throw new Error('Authorize.net transaction could not be verified')
  const amountCents=Math.round(Number(t.transactionStatus==='voided' ? t.authAmount : t.settleAmount ?? t.authAmount)*100)
  if(!Number.isSafeInteger(amountCents) || amountCents<=0) throw new Error('Invalid Authorize.net transaction amount')
  return {test:settings.anet_environment!=='live',paid:['capturedPendingSettlement','settledSuccessfully'].includes(t.transactionStatus) && String(t.responseCode)==='1',amountCents,currency:String(settings.anet_currency || 'USD').toUpperCase(),reference:String(t.order?.invoiceNumber || ''),status:t.transactionStatus,transactionType:t.transactionType,originalTransactionId:String(t.refTransId || ''),responseCode:String(t.responseCode),transactionId:String(t.transId)}
}
export function verifyAuthorizeWebhook(raw,signature,key) {
  if(!/^[a-f0-9]{128}$/i.test(String(key || '')) || !/^sha512=[a-f0-9]{128}$/i.test(String(signature || ''))) return false
  const actual=Buffer.from(signature.slice(7),'hex')
  // Accept the published binary-key representation and the literal signature-key representation
  // used by webhook senders. Both require the entire merchant secret and exact raw request body.
  const digests=[Buffer.from(key,'hex'),Buffer.from(key,'utf8')].map(k=>crypto.createHmac('sha512',k).update(raw).digest())
  return digests.map(expected=>actual.length===expected.length && crypto.timingSafeEqual(actual,expected)).some(Boolean)
}
