// Loaded AFTER the demo network guard. Synthetic responses only; no network fallback.
import {readFileSync,writeFileSync} from 'node:fs'
const path=process.env.PSC_PAYMENT_FIXTURE
if(!path || process.env.PSC_DEMO!=='1') throw new Error('Payment fixture requires an isolated demo')
const read=()=>JSON.parse(readFileSync(path,'utf8'))
const write=s=>writeFileSync(path,JSON.stringify(s))
const reply=d=>new Response(JSON.stringify(d),{status:200,headers:{'content-type':'application/json'}})
globalThis.fetch=async (url,opts={})=>{
  const u=new URL(url),state=read()
  if(u.origin==='https://api.stripe.com') {
    if(u.pathname==='/v1/account') return reply({object:'account',id:'acct_fixture'})
    if(opts.method==='POST' && u.pathname==='/v1/checkout/sessions') {
      const p=new URLSearchParams(opts.body),id='cs_fixture_'+(++state.seq),metadata={}
      for(const [k,v] of p) if(k.startsWith('metadata[')) metadata[k.slice(9,-1)]=v
      state.sessions[id]={id,object:'checkout.session',mode:'payment',status:'complete',payment_intent:'pi_fixture_'+state.seq,payment_status:'paid',livemode:!opts.headers.Authorization.includes('sk_test_'),amount_total:Number(p.get('line_items[0][price_data][unit_amount]')),currency:p.get('line_items[0][price_data][currency]'),metadata,url:null}
      state.last={id,success:p.get('success_url'),idempotency:opts.headers['Idempotency-Key']};write(state)
      // Creation precedes customer payment. Later verification simulates the completed payment.
      return reply({...state.sessions[id],status:'open',payment_status:'unpaid',payment_intent:null,url:'https://checkout.stripe.com/c/pay/'+id})
    }
    if(u.pathname==='/v1/checkout/sessions' && u.searchParams.has('payment_intent')) return reply({data:Object.values(state.sessions).filter(s=>s.payment_intent===u.searchParams.get('payment_intent')),has_more:false})
    const id=u.pathname.split('/').at(-1)
    if(u.pathname.startsWith('/v1/refunds/') && state.refunds?.[id]) return reply(state.refunds[id])
    if(state.sessions[id]) return reply(state.sessions[id])
  }
  if(['https://api.authorize.net','https://apitest.authorize.net'].includes(u.origin)) {
    const d=JSON.parse(opts.body),ok={messages:{resultCode:'Ok',message:[{text:'Successful.'}]}}
    if(d.authenticateTestRequest) return reply(ok)
    if(d.getHostedPaymentPageRequest) {
      state.hosted=d.getHostedPaymentPageRequest;state.last={token:'fixture-token-'+(++state.seq)};write(state)
      return reply({...ok,token:state.last.token})
    }
    if(d.getTransactionDetailsRequest) {
      const t=state.transactions[d.getTransactionDetailsRequest.transId]
      if(t) return reply({...ok,transaction:t})
      return reply({messages:{resultCode:'Error',message:[{text:'Transaction not found.'}]}})
    }
  }
  throw new Error('External request blocked by payment fixture: '+u.origin)
}
