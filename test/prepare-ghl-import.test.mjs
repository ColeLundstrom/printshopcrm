import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareBundles} from '../bin/prepare-ghl-import.mjs'
test('offline export preparation orders contacts first, splits bounded batches and strips unrelated fields',()=>{
  const source={locationId:'example',contacts:Array.from({length:251},(_,i)=>({id:'c'+i,name:'Person '+i,password:'not exported'})),opportunities:[{id:'o1',contact:{id:'c1'},name:'Shirts'}]}
  const bundles=prepareBundles(source)
  assert.equal(bundles.length,2);assert.equal(bundles[0].contacts.length,250);assert.equal(bundles[1].contacts.length,1)
  assert.equal(bundles[1].opportunities[0].contactId,'c1');assert.equal(bundles[0].contacts[0].password,undefined)
  assert.equal(source.contacts[0].password,'not exported')
})
test('task timestamps require an explicit timezone, with Pacific day conversion and DST',()=>{
  const source={locationId:'example',tasks:[{id:'t',title:'Call',dueDate:'2026-09-16T02:00:00Z'}]}
  assert.throws(()=>prepareBundles(source),/timezone/)
  assert.equal(prepareBundles(source,{timezone:'America/Los_Angeles'})[0].tasks[0].dueDate,'2026-09-15')
  assert.throws(()=>prepareBundles(source,{timezone:'not-a-zone'}))
})
