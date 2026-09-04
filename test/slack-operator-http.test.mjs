import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,existsSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {createServer} from 'node:net'
import {createHmac} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
test('signed Slack delivery uses linked identity, replies in DM and rejects replay and foreign teams', {timeout:120000},async()=>{
  const tmp=mkdtempSync(join(tmpdir(),'psc-slack-http-')), dest=join(tmp,'demo'), probe=createServer()
  await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
  let child,db,control
  try{
    const built=spawnSync(process.execPath,['bin/demo.mjs',dest,String(port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:90000});assert.equal(built.status,0,built.stderr)
    const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'))
    const captured=join(tmp,'messages.jsonl')
    writeFileSync(join(dest,'fake-slack.mjs'),`import {appendFileSync} from 'node:fs'; const blocked=globalThis.fetch; globalThis.fetch=async(url,options)=>{if(String(url)==='https://slack.com/api/chat.postMessage'){const body=JSON.parse(options.body);appendFileSync(${JSON.stringify(captured)},JSON.stringify(body)+'\\n');return new Response(JSON.stringify({ok:true,ts:'123.456'}),{status:200})}return blocked(url,options)};`)
    let log='';child=spawn(process.execPath,['--no-warnings','--import','./bin/demo-network-guard.mjs','--import','./fake-slack.mjs','server.mjs'],{cwd:dest,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x)
    for(let i=0;i<600&&child.exitCode===null&&!log.includes('(ws /ws live');i++)await new Promise(r=>setTimeout(r,50));assert.match(log,/ws \/ws live/)
    const base=`http://127.0.0.1:${port}`
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dylan@example.test',password:readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]})});assert.equal(login.status,200)
    const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
    const slug=readdirSync(join(dest,'data/tenants'))[0];db=new DatabaseSync(join(dest,'data/tenants',slug,'printshop.db'));control=new DatabaseSync(join(dest,'data/control.db'))
    const owner=control.prepare('SELECT id,tenant_id FROM members LIMIT 1').get(),tenant=control.prepare('SELECT embed_key FROM tenants WHERE id=?').get(owner.tenant_id)
    for(const [k,v]of Object.entries({slack_team_id:'TTEST',slack_bot_token:'xoxb-synthetic',slack_signing_secret:'synthetic-secret'}))db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,v)
    const cfg=await fetch(base+'/api/slack-operator',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({enabled:true,mode:'review',links:[{user_id:'UOWNER',member_id:owner.id}]})});assert.equal(cfg.status,200,await cfg.clone().text())
    const delivery=async(id,team='TTEST',bad=false)=>{
      const raw=JSON.stringify({event_id:id,team_id:team,event:{type:'message',channel_type:'im',channel:'DTEST',user:'UOWNER',ts:'123.001',text:'job JOB-1001'}}),ts=String(Math.floor(Date.now()/1000))
      return fetch(base+'/api/slack/'+tenant.embed_key+'/events',{method:'POST',headers:{'Content-Type':'application/json','x-slack-request-timestamp':ts,'x-slack-signature':bad?'v0=wrong':'v0='+createHmac('sha256','synthetic-secret').update(`v0:${ts}:${raw}`).digest('hex')},body:raw})
    }
    const messages=()=>existsSync(captured)?readFileSync(captured,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]
    assert.equal((await delivery('EONE')).status,200)
    for(let i=0;i<100&&messages().length<1;i++)await new Promise(r=>setTimeout(r,20))
    assert.equal(messages().length,1,log);assert.match(messages()[0].text,/JOB-1001/);assert.equal(messages()[0].thread_ts,undefined);assert.equal(messages()[0].mrkdwn,false)
    assert.equal((await delivery('EONE')).status,200)
    assert.equal((await delivery('EBAD','TTEST',true)).status,401)
    assert.equal((await delivery('EOTHER','TOTHER')).status,200)
    for(let i=0;i<100&&messages().length<2;i++)await new Promise(r=>setTimeout(r,20))
    assert.equal(messages().length,2,log);assert.match(messages()[1].text,/link your Slack/)
    const history=db.prepare('SELECT history FROM slack_operator_threads').get();assert.match(history.history,/JOB-1001/)
    const rotate=await fetch(base+'/api/settings',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({slack_bot_token:'xoxb-replaced-synthetic'})});assert.equal(rotate.status,200)
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='slack_team_id'").get().value,'')
    const enableAgain=await fetch(base+'/api/slack-operator',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({enabled:true,mode:'review',links:[]})});assert.equal(enableAgain.status,400)
  } finally {db?.close();control?.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r))}rmSync(tmp,{recursive:true,force:true})}
})
