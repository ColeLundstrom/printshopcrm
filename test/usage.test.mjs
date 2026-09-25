import test from 'node:test'
import assert from 'node:assert/strict'
import {createUsage,usageEligible} from '../lib/usage.mjs'

test('usage separates reviewed customers, uncertain legacy sessions, support and repeated work dates',()=>{
  let now=Date.parse('2026-09-24T12:00:00Z')
  const u=createUsage(':memory:',()=>now),shops=[{id:1},{id:2},{id:3}]
  u.session('real','member');u.session('support','support');u.classify(1,'customer');u.classify(2,'test')
  u.record(1,'real');u.record(1,'real');u.record(1,'old');u.record(1,'support');u.record(2,'real');u.record(3,'real')
  let r=u.report(shops)
  assert.equal(r.customers_active7,1);assert.equal(r.unreviewed,1)
  assert.equal(r.shops[0].days7,1);assert.equal(r.shops[0].actions30,2);assert.equal(r.shops[0].uncertain_actions30,1)
  now+=7*86400000;r=u.report(shops);assert.equal(r.customers_active7,0);assert.equal(r.customers_active30,1)
  now+=23*86400000;assert.equal(u.report(shops).customers_active30,0)
  assert.throws(()=>u.classify(1,'invalid'));u.close()
})
test('only successful first party browser business writes count',()=>{
  const req={method:'POST',path:'/api/contacts',headers:{'sec-fetch-site':'same-origin','sec-fetch-mode':'cors'}}
  assert.equal(usageEligible(req,201),true)
  for(const status of [301,400,401,403,422,500])assert.equal(usageEligible(req,status),false)
  for(const path of ['/health','/api/admin/shops','/api/v1/contacts','/api/auth/login','/api/export/customers.csv','/api/estimates/1/preview','/api/invoices/1/send'])assert.equal(usageEligible({...req,path},200),false)
  assert.equal(usageEligible({...req,method:'GET'},200),false)
  assert.equal(usageEligible({...req,headers:{}},200),false)
  assert.equal(usageEligible({...req,headers:{...req.headers,'x-psc-synthetic':'1'}},200),false)
})
test('measurement failure does not break login or work and never reports a false zero',()=>{
  const u=createUsage('/nonexistent/usage/no.db')
  assert.doesNotThrow(()=>u.session('token','member'));assert.doesNotThrow(()=>u.record(1,'token'))
  assert.equal(u.report([{id:1}]).available,false);assert.throws(()=>u.classify(1,'customer'))
})
