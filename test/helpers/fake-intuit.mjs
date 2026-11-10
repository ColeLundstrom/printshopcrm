// A fake Intuit for tests: preloaded with --import, it answers the OAuth and company API hosts
// from memory and records every call. Nothing here reaches the network.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const DIR = process.env.FAKE_INTUIT_DIR
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const log = (o) => appendFileSync(`${DIR}/calls.jsonl`, JSON.stringify(o) + '\n')
const flag = (name) => existsSync(`${DIR}/${name}`)
let n = 100, access = 'access-1'
const real = globalThis.fetch
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url))
  if (!/(^|\.)intuit\.com$/.test(u.hostname)) { if (/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) return real(url, opts); throw new Error('blocked host ' + u.hostname) }
  const body = typeof opts.body === 'string' ? opts.body : ''
  const auth = String(opts.headers?.Authorization || '')
  if (u.hostname === 'oauth.platform.intuit.com') {
    const form = Object.fromEntries(new URLSearchParams(body))
    log({ kind: 'token', grant: form.grant_type, code: form.code, refresh: form.refresh_token, redirect: form.redirect_uri, basic: auth.startsWith('Basic ') })
    if (flag('refresh-dead') && form.grant_type === 'refresh_token') return J({ error: 'invalid_grant', error_description: 'Token has been revoked' }, 400)
    if (form.grant_type === 'authorization_code' && form.code !== 'good-code') return J({ error: 'invalid_grant' }, 400)
    access = 'access-' + (++n)
    return J({ access_token: access, refresh_token: 'refresh-' + n, expires_in: 3600 })
  }
  const path = u.pathname.replace(/^\/v3\/company\/[^/]+\//, '')
  const json = body ? JSON.parse(body) : null
  log({ kind: 'api', host: u.hostname, method: opts.method || 'GET', path, query: u.searchParams.get('query') || '', op: u.searchParams.get('operation') || '', body: json, token: auth.replace('Bearer ', '') })
  if (flag('expire-once') && auth === 'Bearer ' + readFileSync(`${DIR}/expire-once`, 'utf8').trim()) return J({ Fault: { Error: [{ Message: 'AuthenticationFailed' }] } }, 401)
  if (flag('all-401')) return J({ Fault: { Error: [{ Message: 'AuthenticationFailed' }] } }, 401)
  if (path.startsWith('companyinfo/')) return J({ CompanyInfo: { CompanyName: 'Fixture Print Co', Country: 'US' } })
  if (path === 'query') {
    const q = u.searchParams.get('query') || ''
    if (/FROM Item/.test(q)) return J({ QueryResponse: flag('tax-item-exists') ? { Item: [{ Id: '55', Name: 'Sales Tax (PrintShopCRM)' }] } : {} })
    if (/FROM Account/.test(q) && /Sales Tax Payable/.test(q)) return J({ QueryResponse: {} })
    if (/FROM Account/.test(q)) return J({ QueryResponse: { Account: [{ Id: '79', Name: 'Sales Income' }] } })
    return J({ QueryResponse: {} })
  }
  if (path === 'account') return J({ Account: { Id: '90', Name: json.Name } })
  if (path === 'item') return flag('item-refused') ? J({ Fault: { Error: [{ Message: 'Invalid account type', Detail: 'Income account required' }] } }, 400) : J({ Item: { Id: '55', Name: json.Name } })
  if (path === 'customer') return J({ Customer: { Id: String(++n) } })
  if (path === 'invoice') {
    if (flag('invoice-500')) return J({ Fault: { Error: [{ Message: 'Service unavailable' }] } }, 503)
    const total = (json.Line || []).reduce((t, l) => t + (Number(l.Amount) || 0), 0) + (flag('ast-adds-tax') ? 5 : 0)
    return J({ Invoice: { Id: json.Id || String(++n), SyncToken: String((Number(json.SyncToken) || 0) + 1), TotalAmt: Math.round(total * 100) / 100 } })
  }
  if (path === 'payment') return J({ Payment: { Id: String(++n) } })
  return J({ Fault: { Error: [{ Message: 'unknown path ' + path }] } }, 400)
}
