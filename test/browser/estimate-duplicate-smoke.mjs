#!/usr/bin/env node
/** Sandbox-enabled desktop/mobile checks. Only disposable, outbound-blocked shop data. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from '../helpers/http-test-server.mjs'
import { isolateBrowser, redact, requestLabel } from './isolation.mjs'
import { duplicateResponseFault } from './duplicate-response-fault.mjs'
import { leaveQuoteForEstimateList } from './workflow-navigation.mjs'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'), artifacts=join(root,'browser-artifacts')
const report={browser:'Google Chrome with sandbox enabled',data:'Disposable synthetic demo',realtimeCoverage:'Exact local /ws is mocked; real realtime delivery is not covered.',scenarios:[]}
const secrets=[]
let server,browser,temp,cookie
async function request(path,body) {
  const response=await fetch(server.base+path,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
  assert.equal(response.status,200,'Synthetic API fixture failed: '+path)
  return response.json()
}
async function exercise(viewport,cookies) {
  const scenario={name:viewport.name,screenshots:[],checks:[],consoleErrors:[],expectedConsoleErrors:[],pageErrors:[],blockedRequests:[],networkErrors:[],mockedWebSockets:[],writes:[]}
  report.scenarios.push(scenario)
  const context=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},isMobile:viewport.mobile,hasTouch:viewport.mobile,deviceScaleFactor:1,locale:'en-US',colorScheme:'light',reducedMotion:'reduce',serviceWorkers:'block'})
  const isolation=await isolateBrowser(context,server.base,scenario)
  await context.addCookies(cookies)
  const page=await context.newPage();page.setDefaultTimeout(15000)
  let fault,duplicateEndpoint,lostConsoleBudget=0
  page.on('console',m=>{
    if(m.type()!=='error')return
    // Chromium may report the single deliberately lost response as a resource error.
    if(lostConsoleBudget>0 && m.location().url===duplicateEndpoint && /net::ERR_FAILED/.test(m.text())) {
      lostConsoleBudget--;scenario.expectedConsoleErrors.push('Synthetic committed duplicate response deliberately lost');return
    }
    scenario.consoleErrors.push(redact(m.text(),secrets))
  })
  page.on('pageerror',e=>scenario.pageErrors.push(redact(e.stack||e,secrets)))
  page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))scenario.writes.push(r.method()+' '+requestLabel(r.url()))})
  const screenshot=async name=>{
    assert.equal(new URL(page.url()).pathname,'/','Only capture the signed-in app')
    const filename=`quote-duplicate-${viewport.name}-${name}.png`
    await page.screenshot({path:join(artifacts,filename),fullPage:(await page.getByRole('dialog').count())===0,animations:'disabled',mask:[page.locator('input[type="password"]'),page.locator('#share')]})
    scenario.screenshots.push(filename)
  }
  try {
    const sourceCustomer=await request('/api/contacts',{name:`Duplicate source ${viewport.name}`,email:`source-${viewport.name}@example.test`})
    const target=await request('/api/contacts',{name:`Wholesale destination ${viewport.name}`,email:`destination-${viewport.name}@example.test`,tax_exempt:true,billing_address:'12 Fixture Road',shipping_address:'34 Fixture Lane'})
    const source=await request('/api/estimates',{contact_id:sourceCustomer.id,items:[{description:'Synthetic reusable tees',detail:'Blue · two color front',decoration:'Screen Print',sizes:{M:12,XL:8},unit_price:14,taxable:true}],notes:'Review fixture-specific note',rush_days:3,tax_rate:8.25})
    duplicateEndpoint=server.base+`/api/estimates/${source.id}/duplicate`
    fault=await duplicateResponseFault(page,server.base,`/api/estimates/${source.id}/duplicate`,scenario)
    const before=(await request('/api/estimates')).length
    await page.goto(server.base+`/#/estimates/${source.id}`,{waitUntil:'domcontentloaded'})
    await page.getByRole('button',{name:'Duplicate',exact:true}).click()
    assert(await page.getByRole('dialog').evaluate(el=>el.contains(document.activeElement)),'Initial keyboard focus stays inside the dialog')
    const customer=page.getByLabel('Customer for the new quote',{exact:true})
    await customer.selectOption(String(target.id))
    assert.match(await page.locator('#duplicate-review').innerText(),/Review prior prices and customer-specific notes/)
    assert(await page.getByRole('button',{name:'Create draft & edit',exact:true}).isEnabled())
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'No horizontal page overflow')
    await screenshot('review')
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('dialog').count(),0)
    assert(await page.locator('#dup').evaluate(el=>el===document.activeElement),'Close returns keyboard focus')
    assert.equal((await request('/api/estimates')).length,before,'Cancel never creates a draft')
    scenario.checks.push('Customer selection, escaped labels, responsive modal, Escape focus and cancel without a write')
    await page.getByRole('button',{name:'Duplicate',exact:true}).click()
    assert.equal(await customer.inputValue(),String(target.id),'Choice survives closing the dialog')
    await page.getByRole('button',{name:'Create draft & edit',exact:true}).click()
    await page.waitForURL(/#\/estimates\/\d+\/edit$/)
    await page.locator('#contact').waitFor()
    assert.equal(await page.locator('#contact').inputValue(),String(target.id))
    assert.equal(await page.getByLabel('Description, line 1',{exact:true}).inputValue(),'Synthetic reusable tees')
    assert.equal(await page.locator('#tax').inputValue(),'0')
    const copiedId=Number(page.url().match(/estimates\/(\d+)\/edit/)[1]),copy=await request('/api/estimates/'+copiedId)
    assert.equal(copy.contact_id,target.id);assert.equal(copy.status,'draft');assert.equal(copy.tax,0)
    assert.equal(copy.shipping_address,'34 Fixture Lane');assert.deepEqual(copy.items,source.items)
    assert.equal((await request('/api/estimates')).length,before+1)
    await screenshot('draft')
    scenario.checks.push('One new draft, copied sizes and saved prices, selected customer and destination tax/address defaults')
    await page.goBack();await page.locator('#dup').waitFor()
    await page.goForward();await page.locator('#contact').waitFor()
    assert.equal(await page.locator('#contact').inputValue(),String(target.id))
    assert.equal((await request('/api/estimates')).length,before+1,'Back/Forward never creates another copy')
    await isolation.waitForIdle()
    scenario.checks.push('Back/Forward preserves the created draft without repeated writes')

    await page.goBack();await page.locator('#dup').waitFor()
    await page.getByRole('button',{name:'Duplicate',exact:true}).click()
    await customer.selectOption(String(target.id))
    const lost=fault.arm('lose'),lostIndex=fault.requests.length;lostConsoleBudget++
    await page.getByRole('button',{name:'Create draft & edit',exact:true}).click()
    const committed=await lost.committed;assert(!committed.error,committed.error);await lost.finished
    await page.getByRole('button',{name:'Retry same copy',exact:true}).waitFor()
    assert.equal((await request('/api/estimates')).length,before+2,'The lost response already committed one copy')
    assert(await customer.isDisabled());await screenshot('uncertain-response')
    await page.keyboard.press('Escape')
    await page.getByRole('button',{name:'Duplicate',exact:true}).click()
    assert(await page.getByRole('dialog').evaluate(el=>el.contains(document.activeElement)),'Retry-locked dialog still receives keyboard focus')
    await page.getByRole('button',{name:'Retry same copy',exact:true}).click()
    await page.waitForURL(server.base+`/#/estimates/${committed.body.id}/edit`)
    await page.locator('#contact').waitFor()
    assert.deepEqual(fault.requests[lostIndex+1],fault.requests[lostIndex],'Close/reopen sends the exact same durable request')
    assert.equal((await request('/api/estimates')).length,before+2,'The recovery request must not create a second copy')
    scenario.checks.push('Committed response lost, Close/reopen, same-request recovery, exactly one saved copy')

    await page.goBack();await page.locator('#dup').waitFor()
    await page.getByRole('button',{name:'Duplicate',exact:true}).click()
    await customer.selectOption(String(target.id))
    const delayed=fault.arm('delay'),delayedIndex=fault.requests.length
    await page.getByRole('button',{name:'Create draft & edit',exact:true}).click()
    const delayedCommit=await delayed.committed;assert(!delayedCommit.error,delayedCommit.error)
    await page.keyboard.press('Escape')
    // A normal same-document route change preserves the in-memory pending action.
    await leaveQuoteForEstimateList(page,viewport.mobile)
    await page.locator('#new').waitFor()
    delayed.release();await delayed.finished
    await isolation.waitForIdle()
    await page.getByRole('button',{name:'+ New Estimate',exact:true}).waitFor()
    assert.equal(new URL(page.url()).hash,'#/estimates','A late creation response must not hijack the newer page')
    await page.goBack();await page.locator('#dup').waitFor()
    await page.getByRole('button',{name:'Duplicate',exact:true}).click()
    await page.getByRole('button',{name:`Open ${delayedCommit.body.estimate_number}`,exact:true}).waitFor()
    await screenshot('offscreen-recovery')
    await page.getByRole('button',{name:`Open ${delayedCommit.body.estimate_number}`,exact:true}).click()
    await page.waitForURL(server.base+`/#/estimates/${delayedCommit.body.id}/edit`)
    await page.locator('#contact').waitFor()
    assert.deepEqual(fault.requests[delayedIndex+1],fault.requests[delayedIndex],'Opening cached completion revalidates its original receipt')
    assert.equal((await request('/api/estimates')).length,before+3,'Delayed completion and receipt revalidation create only one copy')
    scenario.checks.push('Navigation before delayed success stays put; reopening revalidates the existing copy')
    await isolation.waitForIdle()
  } finally {try {await fault?.close()}finally{await isolation.close()}}
  assert.deepEqual(scenario.blockedRequests,[]);assert.deepEqual(scenario.networkErrors,[])
  assert.deepEqual(scenario.fixtureErrors,[])
  assert.deepEqual(scenario.consoleErrors,[]);assert.deepEqual(scenario.pageErrors,[])
  assert.equal(scenario.writes.length,5)
  for(const write of scenario.writes)assert.match(write,/POST http:\/\/127\.0\.0\.1:\d+\/api\/estimates\/\d+\/duplicate$/)
  assert(scenario.mockedWebSockets.length>0)
  scenario.status='passed'
}

try {
  mkdirSync(artifacts,{recursive:true})
  const {chromium}=await import(pathToFileURL(join(root,'.browser-tools/node_modules/playwright/index.mjs')).href)
  temp=mkdtempSync(join(tmpdir(),'psc-duplicate-browser-'));const dest=join(temp,'demo')
  server=await createHttpTestServer()
  const built=spawnSync(process.execPath,['bin/demo.mjs',dest,String(server.port)],{cwd:root,encoding:'utf8',timeout:120000})
  assert.equal(built.status,0,'Synthetic demo preparation failed')
  const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'));env.PSC_TICK_MS='3600000'
  const password=readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/^Password: (.+)$/m)?.[1]
  secrets.push(password,env.PSC_SECRET)
  await server.start({cwd:dest,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs']})
  const login=await fetch(server.base+'/api/auth/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dylan@example.test',password})})
  assert.equal(login.status,200)
  const session=login.headers.getSetCookie().find(c=>c.startsWith('psc_session='))?.split(';')[0].slice('psc_session='.length)
  assert(session);secrets.push(session);cookie='psc_session='+session
  const cookies=[{name:'psc_session',value:session,url:server.base,httpOnly:true,sameSite:'Lax'}]
  browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});report.browserVersion=browser.version()
  for(const viewport of [{name:'desktop',width:1440,height:1000,mobile:false},{name:'mobile',width:390,height:844,mobile:true}])await exercise(viewport,cookies)
  report.status='passed'
} catch(error) {report.status='failed';report.error=redact(error.stack||error,secrets);console.error(report.error);process.exitCode=1}
finally {
  try {await browser?.close();await server?.close();if(temp)rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
  catch(error) {report.status='failed';report.cleanupError=redact(error.stack||error,secrets);process.exitCode=1}
  writeFileSync(join(artifacts,'quote-duplicate-report.json'),redact(JSON.stringify(report,null,2),secrets)+'\n')
}
