import crypto from 'node:crypto'

export const authorizeConfigured = s => !!(String(s?.anet_login_id || '').trim() && String(s?.anet_transaction_key || '').trim() && /^[a-f0-9]{128}$/i.test(String(s?.anet_signature_key || '')))
export const authorizeEndpoint = s => s?.anet_environment === 'live' ? 'https://api.authorize.net/xml/v1/request.api' : 'https://apitest.authorize.net/xml/v1/request.api'
export const authorizeFormUrl = s => s?.anet_environment === 'live' ? 'https://accept.authorize.net/payment/payment' : 'https://test.authorize.net/payment/payment'

const RESPONSE_BYTES=1024*1024,MAX_REQUESTS=16
let activeRequests=0
const SAFE_ERRORS={
  authorize_rejected:[502,'Authorize.net could not complete this request. Check the merchant connection and payment status before trying again.'],
  authorize_unavailable:[503,'Authorize.net is unavailable. Check the payment status before trying again.'],
  authorize_timeout:[504,'Authorize.net did not respond in time. Check the payment status before trying again.'],
  authorize_invalid:[502,'Authorize.net returned an invalid response. Check the payment status before trying again.'],
  authorize_too_large:[502,'Authorize.net returned an oversized response. Ask the shop owner to check the merchant connection.'],
  authorize_busy:[503,'Payment verification is busy. Wait a moment and check the payment status before trying again.'],
}
class AuthorizeRequestError extends Error{
  constructor(code,uncertain=false){super(SAFE_ERRORS[code][1]);this.code=code;this.status=SAFE_ERRORS[code][0];this.authorizeSafe=true;this.outcome_uncertain=uncertain}
}
const cancelBody=response=>{try{void response?.body?.cancel().catch(()=>{})}catch{}}

/** All existing and collection-client calls share bounded, redacted transport. No write retries. */
export async function requestAuthorize(settings,method,body,send=fetch,timeoutMs=15000){
  if(!String(settings?.anet_login_id || '').trim() || !settings?.anet_transaction_key)throw new Error('Enter the Authorize.net API Login ID and Transaction Key before testing.')
  if(!['authenticateTestRequest','getHostedPaymentPageRequest','getTransactionDetailsRequest'].includes(method))throw new TypeError('Unsupported Authorize.net request')
  if(!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>15000)throw new TypeError('Invalid Authorize.net request deadline')
  if(activeRequests>=MAX_REQUESTS)throw new AuthorizeRequestError('authorize_busy')
  const uncertain=method==='getHostedPaymentPageRequest',controller=new AbortController()
  const plain=typeof body==='string'?body:JSON.stringify(body)
  if(typeof plain!=='string' || Buffer.byteLength(plain)>65536)throw new TypeError('Invalid saved Authorize.net request')
  let parsed;try{parsed=JSON.parse(plain)}catch{throw new TypeError('Invalid saved Authorize.net request')}
  if(!parsed || typeof parsed!=='object' || Array.isArray(parsed) || Object.hasOwn(parsed,'merchantAuthentication'))throw new TypeError('Invalid saved Authorize.net request')
  // Retain canonical noncredential bytes exactly; authentication belongs only to this captured
  // transport. The provider requires merchantAuthentication before the request-specific fields.
  const inside=plain.trim().slice(1,-1)
  const payload=`{"${method}":{"merchantAuthentication":${JSON.stringify({name:settings.anet_login_id,transactionKey:settings.anet_transaction_key})}${inside.trim()?','+inside:''}}}`
  let timer,timedOut=false;activeRequests++
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(new AuthorizeRequestError('authorize_timeout',uncertain))},timeoutMs)})
  const perform=async()=>{
    const response=await send(authorizeEndpoint(settings),{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,redirect:'error',body:payload})
    if(timedOut){cancelBody(response);throw new AuthorizeRequestError('authorize_timeout',uncertain)}
    if(response.redirected || (response.url && new URL(response.url).origin!==new URL(authorizeEndpoint(settings)).origin)){cancelBody(response);throw new AuthorizeRequestError('authorize_invalid',uncertain)}
    if(!response.ok){cancelBody(response);throw new AuthorizeRequestError(response.status>=400 && response.status<500?'authorize_rejected':'authorize_unavailable',uncertain)}
    const declared=response.headers.get('content-length')
    if(declared && /^\d+$/.test(declared) && Number(declared)>RESPONSE_BYTES){cancelBody(response);throw new AuthorizeRequestError('authorize_too_large',uncertain)}
    const reader=response.body?.getReader();if(!reader)throw new AuthorizeRequestError('authorize_invalid',uncertain)
    const cancel=()=>{try{void reader.cancel().catch(()=>{})}catch{}}
    controller.signal.addEventListener('abort',cancel,{once:true})
    const bytes=Buffer.allocUnsafeSlow(RESPONSE_BYTES);let length=0
    try{
      for(;;){const chunk=await reader.read();if(timedOut)throw new AuthorizeRequestError('authorize_timeout',uncertain);if(chunk.done)break
        if(!(chunk.value instanceof Uint8Array) || chunk.value.byteLength>RESPONSE_BYTES-length)throw new AuthorizeRequestError('authorize_too_large',uncertain)
        bytes.set(chunk.value,length);length+=chunk.value.byteLength}
      let data;try{data=JSON.parse(bytes.toString('utf8',0,length).replace(/^\uFEFF/,''))}catch{throw new AuthorizeRequestError('authorize_invalid',uncertain)}
      if(!data || typeof data!=='object' || Array.isArray(data))throw new AuthorizeRequestError('authorize_invalid',uncertain)
      if(data.messages?.resultCode!=='Ok')throw new AuthorizeRequestError('authorize_rejected',uncertain)
      return data
    }catch(error){cancel();throw error}finally{controller.signal.removeEventListener('abort',cancel);reader.releaseLock()}
  }
  try{return await Promise.race([perform(),deadline])}
  catch(error){if(error instanceof AuthorizeRequestError)throw error;throw new AuthorizeRequestError(timedOut?'authorize_timeout':'authorize_unavailable',uncertain)}
  finally{clearTimeout(timer);activeRequests--}
}
const request=requestAuthorize
export async function testAuthorize(settings,send=fetch) {
  const d=await request(settings,'authenticateTestRequest',{},send)
  return {ok:d.messages.resultCode==='Ok',environment:settings.anet_environment === 'live' ? 'live' : 'sandbox'}
}
export function buildAuthorizeCollectionRequest({amountCents,reference,successUrl,cancelUrl,customerEmail,currency='USD'},{merchantCurrency='USD'}={}){
  if(typeof currency!=='string' || !/^[A-Za-z]{3}$/.test(currency) || currency.toUpperCase()!==String(merchantCurrency).toUpperCase())throw new Error('Shop currency must match the Authorize.net merchant-account currency')
  if(!Number.isSafeInteger(amountCents) || amountCents<=0 || typeof reference!=='string' || reference.length!==20 || !/^[A-Za-z0-9_-]+$/.test(reference))throw new Error('Invalid checkout amount or reference')
  for(const value of [successUrl,cancelUrl]){
    let url;try{url=new URL(value)}catch{throw new TypeError('Invalid checkout return URL')}
    if(typeof value!=='string' || value.length>2048 || /[\x00-\x1f\x7f]/.test(value) || !['http:','https:'].includes(url.protocol) || url.username || url.password)throw new TypeError('Invalid checkout return URL')
  }
  if(customerEmail && (typeof customerEmail!=='string' || customerEmail.length>254 || /[\x00-\x1f\x7f]/.test(customerEmail)))throw new TypeError('Invalid payment email')
  return JSON.stringify({
    transactionRequest:{transactionType:'authCaptureTransaction',currencyCode:currency.toUpperCase(),amount:(amountCents/100).toFixed(2),order:{invoiceNumber:reference,description:'PrintShopCRM invoice payment'},...(customerEmail?{customer:{email:customerEmail}}:{})},
    hostedPaymentSettings:{setting:[
      {settingName:'hostedPaymentReturnOptions',settingValue:JSON.stringify({showReceipt:true,url:successUrl,urlText:'Return to shop',cancelUrl,cancelUrlText:'Cancel'})},
      {settingName:'hostedPaymentPaymentOptions',settingValue:JSON.stringify({cardCodeRequired:true,showCreditCard:true,showBankAccount:false})},
      {settingName:'hostedPaymentCustomerOptions',settingValue:JSON.stringify({showEmail:true,requiredEmail:false,addPaymentProfile:false})},
    ]},
  })
}

/** Authorize.net offers no equivalent create idempotency or hosted-form expiration API. */
export function createAuthorizeCollectionClient(settings,{send=fetch,timeoutMs=15000}={}){
  const captured=Object.freeze(Object.fromEntries(['anet_login_id','anet_transaction_key','anet_signature_key','anet_currency','anet_environment'].map(key=>[key,String(settings?.[key] || '')])))
  if(!captured.anet_login_id.trim() || !captured.anet_transaction_key.trim() || [captured.anet_login_id,captured.anet_transaction_key].some(v=>v.length>512 || /[\x00-\x1f\x7f]/.test(v)))throw new Error('Enter the Authorize.net API Login ID and Transaction Key before collecting a payment.')
  const isTest=captured.anet_environment!=='live',accountId='anet_login_'+crypto.createHash('sha256').update(JSON.stringify([isTest?'sandbox':'live',captured.anet_login_id])).digest('hex')
  return Object.freeze({provider:'authorize_net',isTest,supportsIdempotency:false,supportsExpiration:false,
    matchesSettings:current=>Object.keys(captured).every(key=>String(current?.[key] || '')===captured[key]),
    async account(){await request(captured,'authenticateTestRequest',{},send,timeoutMs);return{account_id:accountId,is_test:isTest,destination:null}},
    buildRequest:input=>buildAuthorizeCollectionRequest(input,{merchantCurrency:captured.anet_currency || 'USD'}),
    async create({requestBody}){
      if(typeof requestBody!=='string' || Buffer.byteLength(requestBody)>65536)throw new TypeError('Invalid saved Authorize.net checkout request')
      let saved;try{saved=JSON.parse(requestBody)}catch{throw new TypeError('Invalid saved Authorize.net checkout request')}
      const t=saved?.transactionRequest,reference=t?.order?.invoiceNumber
      if(typeof requestBody!=='string' || t?.transactionType!=='authCaptureTransaction' || typeof reference!=='string' || reference.length!==20 || !/^[A-Za-z0-9_-]+$/.test(reference) ||
        typeof t.amount!=='string' || !/^\d+\.\d{2}$/.test(t.amount) || t.currencyCode!==(captured.anet_currency || 'USD').toUpperCase())throw new TypeError('Invalid saved Authorize.net checkout request')
      const amountCents=Math.round(Number(t.amount)*100)
      if(!Number.isSafeInteger(amountCents) || amountCents<=0)throw new TypeError('Invalid saved Authorize.net checkout amount')
      const response=await request(captured,'getHostedPaymentPageRequest',requestBody,send,timeoutMs)
      if(typeof response.token!=='string' || !response.token || response.token.length>16384 || /[\x00-\x1f\x7f]/.test(response.token))throw new AuthorizeRequestError('authorize_invalid',true)
      return{id:reference,url:authorizeFormUrl(captured),formUrl:authorizeFormUrl(captured),token:response.token,status:'open',paid:false,test:isTest,amountCents,currency:t.currencyCode,metadata:{reference},amountVerified:false}
    },
    retrieveTransaction:transactionId=>retrieveAuthorizeTransaction({settings:captured,transactionId,send,timeoutMs}),
  })
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
export async function retrieveAuthorizeTransaction({settings,transactionId,send=fetch,timeoutMs=15000}) {
  if(!/^\d{1,30}$/.test(String(transactionId)) || /\s/.test(String(transactionId))) throw new Error('Invalid Authorize.net transaction ID')
  const d=await request(settings,'getTransactionDetailsRequest',{transId:String(transactionId)},send,timeoutMs)
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
