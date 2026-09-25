import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
export const USAGE_KINDS = ['unreviewed','customer','demo','test','internal']
export function usageEligible(req,status) {
  return status>=200 && status<300 && ['POST','PUT','PATCH','DELETE'].includes(req.method)
    && /^\/api\/(contacts|estimates|invoices|jobs|opportunities)(?:\/|$)/.test(req.path)
    && req.headers['sec-fetch-site']==='same-origin'
    && ['cors','same-origin'].includes(req.headers['sec-fetch-mode']) && !req.headers['x-psc-synthetic']
}
export function createUsage(path,clock=()=>Date.now()) {
  let db,error=null
  try {
    db=new DatabaseSync(path)
    db.exec(`PRAGMA busy_timeout=50; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS classification(tenant_id INTEGER PRIMARY KEY,kind TEXT NOT NULL,reviewed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS days(tenant_id INTEGER NOT NULL,day TEXT NOT NULL,source TEXT NOT NULL,actions INTEGER NOT NULL,last_at TEXT NOT NULL,PRIMARY KEY(tenant_id,day,source));`)
    db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('started_at',new Date(clock()).toISOString())
  } catch { error='Usage measurement unavailable' }
  const hash=token=>createHash('sha256').update(String(token)).digest('hex')
  function safely(fn) { try { if(!db || error)return;return fn() } catch { error='Usage measurement unavailable' } }
  return {
    session(token,source) { safely(()=>db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?)').run(hash(token),source)) },
    record(tenantId,token) { safely(()=>{
      const source=db.prepare('SELECT source FROM sessions WHERE hash=?').get(hash(token))?.source || 'unknown'
      if(source==='support')return
      const at=new Date(clock()).toISOString()
      db.prepare(`INSERT INTO days VALUES(?,?,?,1,?) ON CONFLICT(tenant_id,day,source) DO UPDATE SET actions=actions+1,last_at=excluded.last_at`).run(tenantId,at.slice(0,10),source,at)
    }) },
    classify(id,kind) {
      if(!USAGE_KINDS.includes(kind))throw new Error('Choose a valid account classification.')
      if(error || !db)throw new Error('Usage measurement unavailable')
      db.prepare('INSERT INTO classification VALUES(?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET kind=excluded.kind,reviewed_at=excluded.reviewed_at').run(id,kind,new Date(clock()).toISOString())
    },
    report(tenants) {
      const result=safely(()=>{
        const since=days=>new Date(clock()-days*86400000).toISOString().slice(0,10)
        const labels=new Map(db.prepare('SELECT * FROM classification').all().map(x=>[x.tenant_id,x]))
        const rows=db.prepare(`SELECT tenant_id,source,MAX(last_at) last_at,SUM(actions) actions,COUNT(*) days30,
          SUM(CASE WHEN day>=? THEN 1 ELSE 0 END) days7 FROM days WHERE day>=? GROUP BY tenant_id,source`).all(since(6),since(29))
        const shops=tenants.map(t=>{
          const own=rows.filter(x=>x.tenant_id===t.id),known=own.find(x=>x.source==='member')
          return {id:t.id,kind:labels.get(t.id)?.kind || 'unreviewed',reviewed_at:labels.get(t.id)?.reviewed_at || null,
            days7:known?.days7 || 0,days30:known?.days30 || 0,actions30:known?.actions || 0,last_at:known?.last_at || null,
            uncertain_actions30:own.filter(x=>x.source!=='member').reduce((n,x)=>n+x.actions,0)}
        })
        return {available:true,started_at:db.prepare("SELECT value FROM meta WHERE key='started_at'").get().value,shops,
          customer_shops:shops.filter(x=>x.kind==='customer').length,
          customers_active7:shops.filter(x=>x.kind==='customer' && x.days7>0).length,
          customers_active30:shops.filter(x=>x.kind==='customer' && x.days30>0).length,
          unreviewed:shops.filter(x=>x.kind==='unreviewed').length}
      })
      return result || {available:false,error:error || 'Usage measurement unavailable'}
    },close() {db?.close()},
  }
}
