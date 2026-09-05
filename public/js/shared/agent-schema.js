// Build an importable tool file without copying credentials or shop records into it.
export function scopedAgentSchema(source, scopes, origin) {
  const site=new URL(origin)
  if(!['http:','https:'].includes(site.protocol) || site.username || site.password)throw Error('Use the shop HTTP or HTTPS address')
  const schema=structuredClone(source)
  schema.servers=[{url:site.origin+'/api/v1'}]
  for(const [path,methods] of Object.entries(schema.paths)) {
    for(const [method,operation] of Object.entries(methods))if(operation['x-printshopcrm-scope']!=='identity' && !scopes.includes(operation['x-printshopcrm-scope']))delete methods[method]
    if(!Object.keys(methods).length)delete schema.paths[path]
  }
  return schema
}
