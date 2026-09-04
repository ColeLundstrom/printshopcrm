import crypto from 'node:crypto'

export const AGENT_SCOPES = {
  'pricing:read': 'Read price books and custom matrices',
  'customers:read': 'Read customers', 'customers:write': 'Create customers',
  'estimates:read': 'Read estimates', 'estimates:write': 'Create draft estimates',
  'invoices:read': 'Read invoices', 'payments:read': 'Read payments',
  'jobs:read': 'Read jobs', 'jobs:stage': 'Change job stages',
  'production:read': 'Read tasks and department queues',
  'production:write': 'Complete, assign and schedule production tasks'
}
const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}) }
const date = () => new Date().toISOString()
const hash = token => crypto.createHash('sha256').update(token).digest('hex')
const publicKey = row => row && ({id:row.id,name:row.name,prefix:row.prefix,member_id:row.member_id,scopes:JSON.parse(row.scopes),created_at:row.created_at,expires_at:row.expires_at,revoked_at:row.revoked_at,last_used_at:row.last_used_at})

// Unknown routes and methods deliberately receive no scope, so future endpoints are not
// implicitly granted to existing agents. Matching is aligned with Express's trailing slash.
export function requiredAgentScope(method,path) {
  const p=path.toLowerCase().replace(/\/$/,''), read=['GET','HEAD'].includes(method)
  if (read && p==='/api/v1/me') return 'identity'
  if (read && (p==='/api/v1/pricing' || /^\/api\/v1\/matrices\/\d+(?:\/price)?$/.test(p)))return 'pricing:read'
  const resource=p.match(/^\/api\/v1\/(customers|estimates|invoices|payments|jobs)(?:\/\d+)?$/)?.[1]
  if(read && resource)return resource+':read'
  if(method==='POST' && /^\/api\/v1\/(customers|estimates)$/.test(p))return p.split('/').at(-1)+':write'
  if(method==='POST' && /^\/api\/v1\/jobs\/\d+\/stage$/.test(p))return 'jobs:stage'
  if(read && (p==='/api/v1/production/queue' || /^\/api\/v1\/jobs\/\d+\/workflow$/.test(p)))return 'production:read'
  if((method==='POST' && /^\/api\/v1\/jobs\/\d+\/tasks\/\d+\/action$/.test(p)) || (method==='PUT' && /^\/api\/v1\/jobs\/\d+\/(timing|tasks\/\d+\/assignment)$/.test(p)))return 'production:write'
  return null
}

export function createAgentAccess(control) {
  control.exec(`CREATE TABLE IF NOT EXISTS agent_keys (
    id INTEGER PRIMARY KEY,tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    name TEXT NOT NULL,prefix TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,last_used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agent_keys_tenant ON agent_keys(tenant_id);
  CREATE TABLE IF NOT EXISTS agent_key_audit (
    id INTEGER PRIMARY KEY,key_id INTEGER NOT NULL REFERENCES agent_keys(id) ON DELETE CASCADE,
    method TEXT NOT NULL,path TEXT NOT NULL,status INTEGER NOT NULL,created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_audit_key ON agent_key_audit(key_id,id);`)
  const activeMember = (tenantId,memberId) => control.prepare("SELECT id,tenant_id,name,role FROM members WHERE id=? AND tenant_id=? AND status='active' AND role IN ('owner','manager')").get(memberId,tenantId)
  return {
    list(tenantId) { return control.prepare('SELECT * FROM agent_keys WHERE tenant_id=? ORDER BY id DESC').all(tenantId).map(publicKey) },
    create(tenantId,memberId,body) {
      if(!activeMember(tenantId,memberId))fail('An active owner or manager account is required.',403)
      if(typeof body.name!=='string' || !body.name.trim() || body.name.trim().length>80)fail('Name this agent using 1–80 characters.')
      if(!Array.isArray(body.scopes) || !body.scopes.length || body.scopes.length>Object.keys(AGENT_SCOPES).length || body.scopes.some(s=>!Object.hasOwn(AGENT_SCOPES,s)))fail('Choose at least one supported permission.')
      if(!Number.isSafeInteger(body.expires_days) || body.expires_days<1 || body.expires_days>365)fail('Expiry must be 1–365 days.')
      if(control.prepare('SELECT count(*) n FROM agent_keys WHERE tenant_id=? AND revoked_at IS NULL AND expires_at>?').get(tenantId,date()).n>=50)fail('Revoke an unused key before creating more than 50 active agent keys.')
      const token='psc_agent_'+crypto.randomBytes(32).toString('base64url')
      const id=Number(control.prepare('INSERT INTO agent_keys(tenant_id,member_id,name,prefix,token_hash,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(tenantId,memberId,body.name.trim(),token.slice(0,16),hash(token),JSON.stringify([...new Set(body.scopes)]),date(),new Date(Date.now()+body.expires_days*86400000).toISOString()).lastInsertRowid)
      return {key:publicKey(control.prepare('SELECT * FROM agent_keys WHERE id=?').get(id)),token}
    },
    revoke(tenantId,id) {
      const result=control.prepare('UPDATE agent_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND tenant_id=?').run(date(),id,tenantId)
      if(!result.changes)fail('Agent key not found.',404)
    },
    resolve(token) {
      if(!/^psc_agent_[A-Za-z0-9_-]{43}$/.test(token))return null
      const row=control.prepare('SELECT * FROM agent_keys WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(hash(token),date())
      if(!row)return null
      const member=activeMember(row.tenant_id,row.member_id)
      const tenant=control.prepare("SELECT * FROM tenants WHERE id=? AND status='active'").get(row.tenant_id)
      return member && tenant ? {key:publicKey(row),member,tenant}:null
    },
    record(id,method,path,status) {
      // No query strings, request bodies, responses, user messages or credentials are retained.
      control.prepare('INSERT INTO agent_key_audit(key_id,method,path,status,created_at) VALUES(?,?,?,?,?)').run(id,method,path.slice(0,200),status,date())
      control.prepare('UPDATE agent_keys SET last_used_at=? WHERE id=?').run(date(),id)
      control.prepare('DELETE FROM agent_key_audit WHERE key_id=? AND id NOT IN (SELECT id FROM agent_key_audit WHERE key_id=? ORDER BY id DESC LIMIT 1000)').run(id,id)
    },
    audit(tenantId,id) {
      if(!control.prepare('SELECT id FROM agent_keys WHERE id=? AND tenant_id=?').get(id,tenantId))fail('Agent key not found.',404)
      return control.prepare('SELECT method,path,status,created_at FROM agent_key_audit WHERE key_id=? ORDER BY id DESC LIMIT 50').all(id)
    }
  }
}
