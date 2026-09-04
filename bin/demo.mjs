#!/usr/bin/env node
/** Build a completely separate evaluation install. Never opens the caller's database or .env. */
import { cpSync, mkdirSync, writeFileSync, readdirSync, chmodSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [destination, portArg = '4380'] = process.argv.slice(2)
if (!destination || ['--help', '-h'].includes(destination)) {
  console.log('Usage: npm run demo -- <new-directory> [port]\nCreates an isolated Dylan demo; never replaces an existing directory. Run start.mjs there to preview.')
  process.exit(destination ? 0 : 1)
}
const port = Number(portArg)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer from 1024 to 65535')
const dest = resolve(destination)
mkdirSync(dest, { mode: 0o700 }) // exclusive: an existing install must never be overwritten
const cleanEnv = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
for (const name of ['lib', 'public', 'node_modules']) {
  cpSync(join(ROOT, name), join(dest, name), {
    recursive: true,
    filter: source => !['uploads', '.DS_Store'].includes(source.split(/[\\/]/).at(-1)),
  })
}
for (const name of ['server.mjs', 'seed.mjs', 'package.json', 'package-lock.json', 'LICENSE']) cpSync(join(ROOT, name), join(dest, name))
mkdirSync(join(dest, 'bin'))
cpSync(join(ROOT, 'bin/demo-network-guard.mjs'), join(dest, 'bin/demo-network-guard.mjs'))
const credentials = {
  url: `http://127.0.0.1:${port}/login`,
  email: 'dylan@example.test',
  password: randomBytes(24).toString('base64url'),
}
const env = { ...cleanEnv, PSC_AUTH: '1', PSC_HOST: '127.0.0.1', PSC_TRUST_PROXY: '0',
  PSC_SECRET: randomBytes(32).toString('hex'), PSC_DB: join(dest, 'data', 'printshop.db'),
  PSC_PUBLIC_URL: `http://127.0.0.1:${port}`, PORT: String(port), PSC_DEMO: '1',
  PSC_BRAND_TAG: 'Demo shop · Sample data · External services disabled',
}
function run(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--import', './bin/demo-network-guard.mjs', ...args], {
    cwd: dest, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60000,
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Demo preparation failed')
  return result.stdout
}
run(['--input-type=module', '-e', `
  import {createTenant,saveOnboarding} from './lib/tenants.mjs';
  const t = await createTenant({shop_name:"Dylan Demo Shop",owner_name:"Dylan",owner_email:process.env.DEMO_EMAIL,password:process.env.DEMO_PASSWORD});
  saveOnboarding(t.id,{done:true});
`], { DEMO_EMAIL: credentials.email, DEMO_PASSWORD: credentials.password })
const tenants = readdirSync(join(dest, 'data', 'tenants'))
if (tenants.length !== 1) throw new Error('Expected exactly one demo shop')
const tenantDb = join(dest, 'data', 'tenants', tenants[0], 'printshop.db')
run(['seed.mjs'], { PSC_DB: tenantDb })
run(['--input-type=module', '-e', `
  import {DatabaseSync} from 'node:sqlite';
  const d=new DatabaseSync(process.env.DEMO_TENANT_DB);
  d.prepare('UPDATE settings SET value=? WHERE key=?').run('Dylan Demo Shop','shop_name');
  d.prepare('UPDATE settings SET value=? WHERE key=?').run('Demo shop · Sample data · External services disabled','brand_tagline');
  d.prepare('UPDATE settings SET value=? WHERE key=?').run('Fictional customers and orders for evaluation','shop_tagline');
  d.prepare('UPDATE settings SET value=? WHERE key=?').run('dylan@example.test','shop_email');
  d.prepare("UPDATE contacts SET email='customer-' || id || '@example.test'").run();
  d.close();
`], { DEMO_TENANT_DB: tenantDb })
writeFileSync(join(dest, 'demo-env.json'), JSON.stringify(env, null, 2) + '\n', { mode: 0o600 })
writeFileSync(join(dest, 'LOGIN.txt'), `Local evaluation only. Do not publish this file.\n\n${credentials.url}\nEmail: ${credentials.email}\nPassword: ${credentials.password}\n\nAll customers, invoices, and payments are fictional.\n`, { mode: 0o600 })
writeFileSync(join(dest, 'start.mjs'), `import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
const env=JSON.parse(readFileSync(new URL('./demo-env.json',import.meta.url),'utf8'));
const child=spawn(process.execPath,['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs'],{cwd:new URL('.',import.meta.url),env,stdio:'inherit'});
for(const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>child.kill(sig));
child.on('exit',code=>process.exit(code??1));
`, { mode: 0o600 })
chmodSync(join(dest, 'data'), 0o700)
console.log(`Demo prepared: ${dest}\nStart: node ${JSON.stringify(join(dest, 'start.mjs'))}\nLogin details: ${join(dest, 'LOGIN.txt')}\nOnly synthetic data. Outbound connections are blocked by the demo launcher.`)
