import test from 'node:test'
import assert from 'node:assert/strict'
import {sendPlatformEmail} from '../lib/notify.mjs'
test('platform helper can deliver through the independent relay without any GHL credentials',async()=>{
  const previous={...process.env},fetchBefore=globalThis.fetch,calls=[]
  try{
    for(const key of ['GHL_PIT','GHL_LOCATION_ID','GHL_EMAIL_FROM','SMTP_HOST','SMTP_USER','SMTP_PASS','PSC_RESEND_KEY'])delete process.env[key]
    process.env.PSC_POSTMARK_TOKEN='fixture-postmark'
    delete process.env.PSC_PLATFORM_EMAIL_TRANSPORT
    assert.equal((await sendPlatformEmail({to:'owner@example.test',subject:'Dormant legacy path'})).delivered,false)
    process.env.PSC_PLATFORM_EMAIL_TRANSPORT='independent'
    globalThis.fetch=async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return new Response(JSON.stringify({MessageID:'fixture-message',ErrorCode:0}),{status:200,headers:{'Content-Type':'application/json'}})}
    const result=await sendPlatformEmail({to:'owner@example.test',subject:'Fixture',body:'No actual email is sent.'})
    assert.equal(result.delivered,true);assert.equal(result.via,'relay');assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.postmarkapp.com/email')
    assert.equal(calls[0].body.To,'owner@example.test')
    delete process.env.PSC_POSTMARK_TOKEN
    assert.equal((await sendPlatformEmail({to:'owner@example.test',subject:'Offline'})).delivered,false)
    assert.equal(calls.length,1)
  }finally{globalThis.fetch=fetchBefore;process.env=previous}
})
