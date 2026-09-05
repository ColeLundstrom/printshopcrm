import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { scopedAgentSchema } from '../public/js/shared/agent-schema.js'
import { requiredAgentScope, AGENT_SCOPES } from '../lib/agent-access.mjs'
import { SIZES } from '../public/js/shared/pricing.js'
const schema=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'))

test('agent schema describes actual routes and scopes; exports only permitted tools',()=>{
  const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8'), names=new Set()
  for(const [path,methods] of Object.entries(schema.paths))for(const [method,operation] of Object.entries(methods)) {
    assert.ok(!names.has(operation.operationId)); names.add(operation.operationId)
    const route='/api/v1'+path.replace(/\{([^}]+)\}/g,':$1')
    assert.ok(server.includes(`app.${method}('${route}'`),route+' must exist')
    assert.equal(requiredAgentScope(method.toUpperCase(),'/api/v1'+path.replace(/\{[^}]+\}/g,'1')),operation['x-printshopcrm-scope'])
    for(const name of path.matchAll(/\{([^}]+)\}/g))assert.ok(operation.parameters.some(p=>p.in==='path'&&p.name===name[1]&&p.required))
    if(method!=='get')assert.equal(operation['x-printshopcrm-writes-immediately'],true)
  }
  assert.equal(names.size,22)
  assert.deepEqual(schema.components.schemas.EstimateLine.properties.sizes.propertyNames.enum,SIZES)
  const readonly=Object.keys(AGENT_SCOPES).filter(scope=>scope.endsWith(':read'))
  const filtered=scopedAgentSchema(schema,readonly,'https://shop.example.test/somewhere?secret=discard')
  assert.deepEqual(filtered.servers,[{url:'https://shop.example.test/api/v1'}])
  for(const methods of Object.values(filtered.paths))assert.ok(Object.keys(methods).every(method=>method==='get'))
  assert.ok(!JSON.stringify(filtered).includes('secret=discard'))
  assert.ok(schema.paths['/estimates'].post,'source remains unchanged')
  const writer=scopedAgentSchema(schema,['estimates:write'],'http://127.0.0.1:4382')
  assert.deepEqual(Object.keys(writer.paths).sort(),['/estimates','/me'])
  assert.deepEqual(Object.keys(writer.paths['/estimates']),['post'])
  assert.ok(writer.paths['/estimates'].post.parameters.some(p=>p.name==='Idempotency-Key'))
  assert.deepEqual(Object.keys(scopedAgentSchema(schema,[],'https://example.test').paths),['/me'])
  assert.throws(()=>scopedAgentSchema(schema,[],'https://user:secret@example.test'),/shop HTTP/)
  assert.throws(()=>scopedAgentSchema(schema,[],'file:///tmp/shop'),/shop HTTP/)
  // All local component references resolve, including those retained in a filtered file.
  const inspect=value=>{if(!value||typeof value!=='object')return;if(value.$ref){assert.ok(value.$ref.startsWith('#/'));let found=schema;for(const part of value.$ref.slice(2).split('/'))found=found?.[part];assert.ok(found,value.$ref)}Object.values(value).forEach(inspect)}
  inspect(schema)
})
