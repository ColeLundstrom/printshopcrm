/**
 * AI layer — bring-your-own-key, provider-agnostic.
 *
 * Each shop chooses its own provider (Anthropic or OpenAI) and pastes its own API key in
 * Settings, so model usage bills to THAT shop, not the platform. Provider and key are read from
 * the shop's own settings (scoped by the tenant's database via getSettings), so nothing here is
 * global — one shop can never spend on another's key, or on the platform's.
 *
 * Three rules shaped this file:
 *  1. Bring-your-own-key: a shop's AI runs on the shop's account. No key = no model, and that's
 *     fine — everything degrades to the deterministic parser below.
 *  2. It must work with NO model at all. The front-office bottleneck is manual order entry, not
 *     intelligence; a regex that reads "24 S, 60 M, 80 L" saves the same keystrokes offline.
 *  3. A local `claude` CLI (OAuth) stays as a zero-config fallback for single-tenant/dev use
 *     ONLY — never in multi-tenant production, so no shop can spend on the platform login.
 *
 * Every function returns the same shape whether the model ran or not, tagged with the path that
 * produced it, so the UI can always be honest about what the shop is looking at.
 */
import { execFile } from 'node:child_process'
import { parseGarmentText } from './suppliers.mjs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SIZES } from '../public/js/shared/pricing.js'
import { getSettings } from './db.mjs'

const CLAUDE_BIN = process.env.CLAUDE_BIN || join(homedir(), '.local', 'bin', 'claude')
const MULTI_TENANT = process.env.PSC_AUTH === '1'

export const DEFAULT_MODELS = { anthropic: 'claude-haiku-4-5', openai: 'gpt-4o-mini' }
/** The providers a shop can pick from in Settings — id, label, key format hint, model choices. */
export const AI_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', keyHint: 'sk-ant-…', models: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'] },
  { id: 'openai', label: 'OpenAI (GPT)', keyHint: 'sk-…', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
]

/**
 * Resolve THIS shop's AI configuration from its own settings, or null when no model is connected
 * (the deterministic paths still run). Reads through tenant-scoped getSettings(), so in
 * multi-tenant mode it is always the signed-in shop's own key.
 */
export function aiConfig() {
  let s = {}
  try { s = getSettings() } catch { s = {} }
  const provider = String(s.ai_provider || '').toLowerCase()
  const key = String(s.ai_api_key || '').trim()
  const model = String(s.ai_model || '').trim()
  if (provider === 'anthropic' && key) return { provider, key, model: model || DEFAULT_MODELS.anthropic }
  if (provider === 'openai' && key) return { provider, key, model: model || DEFAULT_MODELS.openai }
  if ((provider === 'cli' || !provider) && !MULTI_TENANT) {
    // Single-tenant / dev only: the locally installed, OAuth'd claude CLI. The guard covers the
    // EXPLICIT choice too — otherwise a shop could store ai_provider='cli' and run every AI feature
    // on the platform's own OAuth login instead of the key it is supposed to bring.
    if (existsSync(CLAUDE_BIN)) return { provider: 'cli', model: process.env.PSC_AI_MODEL || DEFAULT_MODELS.anthropic }
  }
  return null
}

const providerLabel = (cfg) => cfg.provider === 'cli' ? 'claude CLI (OAuth)' : cfg.provider === 'openai' ? 'OpenAI' : 'Anthropic'
const fingerprint = (cfg) => cfg ? `${cfg.provider}:${cfg.model}:${(cfg.key || 'cli').slice(-6)}` : 'none'
const statusCache = new Map() // fingerprint -> { status, at } — per-config so shops don't share a verdict
const AVAILABLE_TTL = 10 * 60 * 1000
const UNAVAILABLE_TTL = 90 * 1000
const invalidateStatus = (cfg) => { if (cfg) statusCache.delete(fingerprint(cfg)) }

/** Is a model reachable for THIS shop right now? Cached per-config with a TTL — the probe costs a call. */
export async function aiStatus(force = false) {
  const cfg = aiConfig()
  if (!cfg) return { available: false, reason: 'No AI model connected. Add your Anthropic or OpenAI API key in Settings to switch on model features — everything else works without it.' }
  const fp = fingerprint(cfg)
  const hit = statusCache.get(fp)
  if (hit && !force && Date.now() - hit.at < (hit.status.available ? AVAILABLE_TTL : UNAVAILABLE_TTL)) return hit.status
  let status
  try {
    const out = await callModel('Reply with exactly: OK', { timeoutMs: 20000, maxTokens: 16, cfg })
    status = /OK/i.test(out)
      ? { available: true, provider: cfg.provider, model: cfg.model, via: providerLabel(cfg) }
      : { available: false, reason: `Unexpected reply from the model: ${out.slice(0, 80)}`, raw: out.slice(0, 200) }
  } catch (e) {
    status = { available: false, provider: cfg.provider, reason: modelError(cfg, e), raw: String(e.message || e).slice(0, 200) }
  }
  statusCache.set(fp, { status, at: Date.now() })
  return status
}

function modelError(cfg, e) {
  const m = String(e.message || e)
  if (cfg.provider === 'cli') return 'Model features are off — run `claude login` in a terminal. Everything else works without it.'
  if (/401|403|invalid.*key|authentication|permission/i.test(m)) return `Your ${providerLabel(cfg)} API key was rejected — check it in Settings.`
  if (/429|rate|quota|insufficient|credit/i.test(m)) return `${providerLabel(cfg)} is rate-limiting or out of credit. Try again shortly.`
  if (/model/i.test(m) && /not|invalid|exist/i.test(m)) return `Model "${cfg.model}" isn't available on your ${providerLabel(cfg)} plan — pick another in Settings.`
  return `Could not reach ${providerLabel(cfg)}: ${m.slice(0, 90)}`
}

/**
 * Probe an explicit provider + key without touching stored settings — used by the "Test
 * connection" button so a bad key is caught before it's saved. Returns the same shape as aiStatus.
 */
export async function testAi({ provider, key, model }) {
  provider = String(provider || '').toLowerCase()
  key = String(key || '').trim()
  if (provider === 'cli') {
    if (MULTI_TENANT) return { available: false, reason: 'Choose a provider (Anthropic or OpenAI) and bring your own key.' }
    if (!existsSync(CLAUDE_BIN)) return { available: false, reason: `No claude CLI installed at ${CLAUDE_BIN}` }
  } else if (!['anthropic', 'openai'].includes(provider)) {
    return { available: false, reason: 'Choose a provider (Anthropic or OpenAI).' }
  } else if (!key) {
    return { available: false, reason: 'Paste your API key to test it.' }
  }
  const cfg = provider === 'cli'
    ? { provider: 'cli', model: model || process.env.PSC_AI_MODEL || DEFAULT_MODELS.anthropic }
    : { provider, key, model: model || DEFAULT_MODELS[provider] }
  try {
    const out = await callModel('Reply with exactly: OK', { timeoutMs: 20000, maxTokens: 16, cfg })
    if (/OK/i.test(out)) return { available: true, provider, model: cfg.model, via: providerLabel(cfg) }
    return { available: false, reason: `Connected, but got an unexpected reply: ${out.slice(0, 60)}` }
  } catch (e) {
    return { available: false, reason: modelError(cfg, e), raw: String(e.message || e).slice(0, 160) }
  }
}

/* ---------- provider dispatch ---------- */

/** One prompt in, text out. Dispatches to the shop's chosen provider; throws on any failure. */
export async function callModel(prompt, { timeoutMs = 45000, maxTokens = 1024, cfg = aiConfig() } = {}) {
  if (!cfg) throw new Error('No AI provider configured')
  if (cfg.provider === 'anthropic') return callAnthropic(prompt, cfg, timeoutMs, maxTokens)
  if (cfg.provider === 'openai') return callOpenAI(prompt, cfg, timeoutMs, maxTokens)
  return runClaude(prompt, cfg.model, timeoutMs)
}

async function httpJson(url, opts, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal })
    const text = await r.text()
    let body; try { body = JSON.parse(text) } catch { body = { raw: text } }
    if (!r.ok) {
      const msg = body?.error?.message || body?.error?.type || (typeof body?.raw === 'string' ? body.raw : '') || `HTTP ${r.status}`
      const err = new Error(`${r.status} ${msg}`.slice(0, 200)); err.status = r.status; throw err
    }
    return body
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)
    throw e
  } finally { clearTimeout(timer) }
}

async function callAnthropic(prompt, cfg, timeoutMs, maxTokens) {
  const body = await httpJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  }, timeoutMs)
  return String(body?.content?.map?.((b) => b?.text || '').join('') || body?.content?.[0]?.text || '').trim()
}

async function callOpenAI(prompt, cfg, timeoutMs, maxTokens) {
  const body = await httpJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  }, timeoutMs)
  return String(body?.choices?.[0]?.message?.content || '').trim()
}

function runClaude(prompt, model, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = execFile(CLAUDE_BIN, ['-p', prompt, '--model', model || DEFAULT_MODELS.anthropic],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' } },
      (err, stdout, stderr) => {
        const text = String(stdout || '')
        // The CLI reports auth failure on stdout with a zero-ish exit in some versions and
        // via err in others, so check every surface before deciding what went wrong.
        const all = `${text}\n${stderr || ''}\n${err?.message || ''}`
        if (/Failed to authenticate|OAuth access token has expired|401|Invalid API key|not logged in/i.test(all)) {
          return reject(new Error('OAuth access token has expired'))
        }
        if (err && !text.trim()) return reject(new Error(String(stderr || err.message).slice(0, 200)))
        resolve(text.trim())
      })
    child.on('error', reject)
  })
}

/** Pull the first JSON object/array out of a model reply that may be wrapped in prose or fences. */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[[{]/)
  if (start === -1) return null
  for (let end = body.length; end > start; end--) {
    try { return JSON.parse(body.slice(start, end)) } catch { /* keep shrinking */ }
  }
  return null
}

/* ================= intake: text -> draft order ================= */

const GARMENTS = [
  { re: /gildan\s*5000|g500\b/i, name: 'Gildan 5000 Tee', cost: 3.20 },
  { re: /gildan\s*18500|hoodie/i, name: 'Gildan 18500 Hoodie', cost: 16.50 },
  { re: /bella\s*\+?\s*canvas\s*3001|bella\s*3001|3001\b/i, name: 'Bella+Canvas 3001 Tee', cost: 4.10 },
  { re: /next\s*level\s*6210|6210\b/i, name: 'Next Level 6210 Tee', cost: 5.25 },
  { re: /richardson\s*112|trucker\s*hat|trucker/i, name: 'Richardson 112 Trucker', cost: 7.50 },
  { re: /polo/i, name: 'Port Authority K500 Polo', cost: 14.00 },
  { re: /apron/i, name: 'Port Authority A700 Apron', cost: 11.00 },
  { re: /tank/i, name: 'Bella+Canvas 8800 Tank', cost: 5.60 },
  { re: /crew|sweatshirt/i, name: 'Gildan 18000 Crewneck', cost: 13.00 },
  { re: /tee|t-?shirt|shirt/i, name: 'Gildan 5000 Tee', cost: 3.20 },
]

const DECOS = [
  { re: /embroider|stitch|digitiz/i, name: 'Embroidery' },
  { re: /uv\s*dtf/i, name: 'UV DTF' }, // MUST precede DTF — "uv dtf" also matches \bdtf\b
  { re: /\bdtf\b|transfer/i, name: 'DTF Transfer' },
  { re: /vinyl|htv/i, name: 'Vinyl' },
  { re: /patch/i, name: 'Patch' },
  { re: /laser|engrav/i, name: 'Laser' },
  { re: /screen|print/i, name: 'Screen Print' },
]

const sizeAlt = () => SIZES.slice().sort((a, b) => b.length - a.length).join('|')
const canonSize = (s) => SIZES.find((x) => x.toLowerCase() === String(s).toLowerCase())

/**
 * Read a size run out of free text. People write it two incompatible ways:
 *
 *   "24 S, 60 M, 80 L"     qty first
 *   "S-24 M-60 L-80"       size first, delimited
 *
 * Naively running both patterns cross-contaminates: in "L-20 M-10" the qty-first pattern
 * happily reads "20 M" across the delimiter and clobbers M. So the delimited form wins,
 * and qty-first only gets to claim spans the delimited form didn't already take.
 */
export function parseSizeRun(text) {
  const t = String(text || '')
  const sizes = {}
  const taken = []
  const overlaps = (a, b) => taken.some(([s, e]) => a < e && b > s)

  for (const m of t.matchAll(new RegExp(`\\b(${sizeAlt()})\\s*[:=\\-]\\s*(\\d{1,4})\\b`, 'gi'))) {
    const size = canonSize(m[1])
    if (!size) continue
    sizes[size] = (sizes[size] || 0) + Number(m[2])
    taken.push([m.index, m.index + m[0].length])
  }

  // `(?:x\s+)?` — the space after x is required, otherwise the optional multiplier eats
  // the X of "36 XL" and books it as 36 L.
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,4})\\s*(?:x\\s+)?(${sizeAlt()})\\b`, 'gi'))) {
    const size = canonSize(m[2])
    if (!size || overlaps(m.index, m.index + m[0].length)) continue
    sizes[size] = (sizes[size] || 0) + Number(m[1])
    taken.push([m.index, m.index + m[0].length])
  }
  return sizes
}

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, single: 1, full: 1 }
const NUM_RE = `(\\d{1,2}|${Object.keys(WORD_NUM).join('|')})`
const toNum = (s) => (WORD_NUM[String(s).toLowerCase()] ?? Number(s)) || 1

/**
 * Colour count per print location. "2 color front and a one color back" has to come out
 * as two locations with 2 and 1 colours — a single global colour count loses the job.
 */
export function colorsPerLocation(text) {
  const t = String(text || '')
  const LOCS = [
    { re: /left\s*chest/i, name: 'Left Chest' },
    { re: /right\s*chest/i, name: 'Right Chest' },
    { re: /\bfront\b|full\s*front/i, name: 'Front' },
    { re: /\bback\b/i, name: 'Back' },
    { re: /\bsleeve\b/i, name: 'Sleeve' },
    { re: /\bhood\b/i, name: 'Hood' },
  ]
  const out = []
  // "<n> color <location>" — the colour count binds to the location that follows it.
  for (const m of t.matchAll(new RegExp(`${NUM_RE}\\s*[- ]?\\s*colou?rs?\\s+(?:\\w+\\s+){0,2}?(left\\s*chest|right\\s*chest|front|back|sleeve|hood)`, 'gi'))) {
    const name = LOCS.find((l) => l.re.test(m[2]))?.name || 'Front'
    if (!out.some((o) => o.name === name)) out.push({ name, colors: Math.min(12, toNum(m[1])) })
  }
  if (out.length) {
    // Locations named without their own colour count inherit the first one mentioned.
    for (const l of LOCS) {
      if (l.re.test(t) && !out.some((o) => o.name === l.name)) out.push({ name: l.name, colors: 1 })
    }
    return out
  }
  // No location-bound counts — fall back to one global colour count.
  const g = t.match(new RegExp(`${NUM_RE}\\s*[- ]?\\s*colou?r`, 'i')) || t.match(new RegExp(`colou?rs?\\s*[:=]?\\s*${NUM_RE}`, 'i'))
  const colors = g ? Math.min(12, toNum(g[1])) : 1
  for (const l of LOCS) if (l.re.test(t)) out.push({ name: l.name, colors })
  return out.length ? out.map((o, i) => ({ ...o, colors: i === 0 ? colors : 1 })) : [{ name: 'Front', colors }]
}


const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const isReal = (y, m, d) => { const x = new Date(y, m, d); return x.getMonth() === m && x.getDate() === d }

/**
 * Pull a stated deadline out of a customer's message and resolve it to an ISO date.
 *
 * The original regex here only understood "Sept 8" and "9/8" — an ISO date, the single most
 * common machine-written form ("by 2026-09-08"), fell straight through and left due_hint null.
 * It also only ever returned the matched *text*, so even a hit needed a second, non-existent
 * step before anything could use it as a date.
 *
 * Everything is resolved relative to `today` and never returns a date in the past: a bare
 * "by Sept 8" written in December means next year, and a deadline that has already passed is a
 * misread rather than a real instruction, so it is dropped instead of back-dating a job.
 */
export function parseDeadline(text, today = new Date()) {
  const t = String(text || '')
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const miss = { date: null, text: null }
  // "by/before/due" etc. A deadline is almost always introduced by one of these; requiring a cue
  // keeps us from reading an order date or a quoted price ("9/8 pricing") as the due date.
  const CUE = '(?:by|before|due(?:\\s+(?:on|by))?|need(?:ed|s)?\\s+(?:it\\s+)?by|no\\s+later\\s+than|deadline(?:\\s+is)?|for)'
  const CUE_NUM = '(?:by|before|due(?:\\s+(?:on|by))?|need(?:ed|s)?\\s+(?:it\\s+)?by|no\\s+later\\s+than|deadline(?:\\s+is)?)'
  const at = (re) => t.match(new RegExp(`\\b${CUE}\\s+${re}`, 'i'))
  // Numeric dates use the stricter cue (no "for") — "quote for 9/8 pricing" must not read 9/8.
  const atNum = (re) => t.match(new RegExp(`\\b${CUE_NUM}\\s+${re}`, 'i'))
  // Retry an out-of-range day (Feb 29, Apr 31) in the next year before giving up — a stated
  // deadline that isn't valid this year usually means next year's valid one.
  const realOrNextYear = (yr, mo, day, explicitYr) => {
    if (isReal(yr, mo, day)) return yr
    if (explicitYr) return null
    // Feb 29 in a non-leap year rolls to the next leap year (up to +4); Apr 31 etc. never resolve.
    for (let k = 1; k <= 4; k++) if (isReal(yr + k, mo, day)) return yr + k
    return null
  }
  const done = (d, m) => (d && d >= base ? { date: iso(d), text: m[0].trim() } : miss)

  // ISO — 2026-09-08 or 2026/09/08. Unambiguous, so it wins outright.
  let m = atNum('(\\d{4})[-/](\\d{2})[-/](\\d{2})')
  if (m && isReal(+m[1], +m[2] - 1, +m[3])) return done(new Date(+m[1], +m[2] - 1, +m[3]), m)

  // US numeric — 9/8, 9/8/26, 9/8/2026, and the dash forms 9-8, 09-08-2026.
  m = atNum('(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2,4}))?')
  if (m) {
    const mo = +m[1] - 1, day = +m[2]
    let yr = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : base.getFullYear()
    const resolvedYr = realOrNextYear(yr, mo, day, !!m[3])
    if (resolvedYr != null) {
      let d = new Date(resolvedYr, mo, day)
      if (!m[3] && d < base) d = new Date(resolvedYr + 1, mo, day) // bare "9/8" in December means next year
      return done(d, m)
    }
  }

  // "September 8", "Sept. 8th", "Sep 8, 2026" — and the reversed "8 September".
  const MON = `(${MONTHS.join('|')})[a-z]*\\.?`
  const DAY = '(\\d{1,2})(?:st|nd|rd|th)?'
  m = at(`${MON}\\s+${DAY}(?:,?\\s+(\\d{4}))?`) || at(`${DAY}\\s+(?:of\\s+)?${MON}(?:,?\\s+(\\d{4}))?`)
  if (m) {
    // The two alternatives capture month and day in opposite order.
    const monIdx = MONTHS.indexOf(String(m[1]).slice(0, 3).toLowerCase())
    const [mo, day] = monIdx >= 0 ? [monIdx, +m[2]] : [MONTHS.indexOf(String(m[2]).slice(0, 3).toLowerCase()), +m[1]]
    let yr = m[3] ? +m[3] : base.getFullYear()
    const resolvedYr = mo >= 0 ? realOrNextYear(yr, mo, day, !!m[3]) : null
    if (resolvedYr != null) {
      let d = new Date(resolvedYr, mo, day)
      if (!m[3] && d < base) d = new Date(resolvedYr + 1, mo, day)
      return done(d, m)
    }
  }

  // "in 3 weeks", "in 10 days", "within two weeks".
  const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
  m = t.match(/\b(?:in|within)\s+(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month)s?\b/i)
  if (m) {
    const n = /^\d+$/.test(m[1]) ? +m[1] : WORDS[m[1].toLowerCase()]
    const unit = m[2].toLowerCase()
    if (n > 0) {
      const d = new Date(base)
      if (unit === 'day') d.setDate(d.getDate() + n)
      else if (unit === 'week') d.setDate(d.getDate() + n * 7)
      else {
        // setMonth overflows (Jan 31 + 1 month → Mar 3). Clamp to the target month's last day.
        const targetDay = d.getDate()
        d.setDate(1); d.setMonth(d.getMonth() + n)
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
        d.setDate(Math.min(targetDay, lastDay))
      }
      return done(d, m)
    }
  }

  // "by Friday" / "next Tuesday" — the next occurrence, never today.
  m = t.match(new RegExp(`\\b(?:${CUE}|next|this)\\s+(${WEEKDAYS.join('|')})\\b`, 'i'))
  if (m) {
    const want = WEEKDAYS.indexOf(m[1].toLowerCase())
    const d = new Date(base)
    let delta = (want - d.getDay() + 7) % 7
    if (delta === 0) delta = 7
    if (/\bnext\b/i.test(m[0]) && delta < 7) delta += 7
    d.setDate(d.getDate() + delta)
    return done(d, m)
  }

  // "tomorrow" — rare in writing but unambiguous when it appears.
  if (/\btomorrow\b/i.test(t)) { const d = new Date(base); d.setDate(d.getDate() + 1); return { date: iso(d), text: 'tomorrow' } }
  return miss
}

/**
 * Deterministic intake. Reads the size run, colour count, garment and dates out of a
 * pasted email. No model involved — this is the part that must never be down.
 */
export function parseIntakeHeuristic(text) {
  const t = String(text || '')
  const sizes = parseSizeRun(t)

  // Customers write "2 color front" and "two color front" about equally often.
  const locations = colorsPerLocation(t)

  // GARMENTS is a 10-row shortlist, and its last entry matches any bare "tee/shirt" — so
  // "Comfort Colors 1717" and "Port & Company PC61" both landed on "Gildan 5000 Tee" and were
  // quoted at a Gildan's cost. When the text names a brand and style we can look up for real,
  // that beats the shortlist; the shortlist stays as the answer for "24 black tees".
  const gmHit = GARMENTS.find((g) => g.re.test(t))
  const generic = !gmHit || gmHit === GARMENTS[GARMENTS.length - 1]
  const parsedG = parseGarmentText(t)
  const titled = (v) => String(v || '').replace(/\b[a-z]/g, (c) => c.toUpperCase())
  const garment = (generic && parsedG.style && parsedG.brand)
    ? { name: `${titled(parsedG.brand)} ${parsedG.style}`, cost: (gmHit || GARMENTS[GARMENTS.length - 1]).cost }
    : (gmHit || GARMENTS[GARMENTS.length - 1])
  const decoration = (DECOS.find((d) => d.re.test(t)) || DECOS[DECOS.length - 1]).name

  // A bare total like "we need 200 shirts" or "24 black tees" when no size grid was given —
  // the count and the garment word needn't be adjacent (a color often sits between).
  let bare = 0
  {
    const m = t.match(/\b(\d{2,4})\b[^.\n]{0,22}?\b(?:pcs?|pieces?|units?|shirts?|tees?|t-?shirts?|hoodies?|hoodys?|polos?|tanks?|jerseys?|crews?|aprons?|hats?|caps?|beanies?)\b/i)
    if (m) bare = Number(m[1])
    // Half the trade writes the style number INSTEAD of a garment noun — "144 Bella+Canvas 3001
    // in White" is ordinary phrasing, and the noun-anchored pattern above finds nothing in it,
    // so the quote came back empty and the shop got no estimate at all. Accept a count that sits
    // in front of a brand or style, and take care not to read the STYLE as the quantity.
    if (!bare) {
      const { style } = parseGarmentText(t)
      const styleNum = /^\d+$/.test(style) ? Number(style) : null
      const m2 = t.match(/(?:^|\n|\bneed\s+|\bwant\s+|\border\s+|\bfor\s+|\bqty\b[:\s]+|\bquantity\b[:\s]+)\s*(\d{1,3}(?:,\d{3})+|\d{1,5})\s*(?:x\s+|pcs?\s+|pieces?\s+)?(?=[A-Za-z])/i)
      if (m2) {
        const n = Number(String(m2[1]).replace(/,/g, ''))
        if (n >= 6 && n !== styleNum) bare = n
      }
    }
  }

  // Pull the garment color so the mockup renders on the right shirt.
  const COLORS = ['black', 'navy', 'white', 'heather', 'red', 'royal', 'forest', 'charcoal', 'maroon', 'sand', 'gold', 'orange', 'green', 'blue', 'purple', 'pink', 'gray', 'grey']
  const colorHit = COLORS.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(t))
  const dark = /\bblack\b|\bnavy\b|dark|charcoal|forest|maroon|royal/i.test(t)
  const rush = /rush|asap|urgent|hurry|need.*(tomorrow|by friday|this week)/i.test(t)
  const deadline = parseDeadline(t)
  // Stitch count drives embroidery price; print area drives DTF. Both were previously never read,
  // so a 15k-stitch logo and a 4k-stitch mark quoted the same. Accept "8000 stitch", "8,000 st",
  // "8k stitches"; and "12x16", "12 x 16 in" for area.
  const stM = t.match(/(\d{1,3}(?:,\d{3})|\d{3,6})\s*(?:stitch|stitches|\bst\b)/i) || t.match(/(\d{1,3})\s*k\s*(?:stitch|stitches|st)/i)
  let stitches = null
  if (stM) { const raw = stM[1].replace(/,/g, ''); stitches = /k\s*(?:stitch|st)/i.test(stM[0]) ? Number(raw) * 1000 : Number(raw) }
  const areaM = t.match(/(\d{1,2}(?:\.\d)?)\s*[x×]\s*(\d{1,2}(?:\.\d)?)/i)
  const print_area = areaM ? Math.round(Number(areaM[1]) * Number(areaM[2])) : null

  return {
    source: 'heuristic',
    garment: garment.name,
    garment_cost: garment.cost,
    decoration,
    sizes,
    total_pieces: Object.values(sizes).reduce((s, n) => s + n, 0) || bare,
    locations,
    garment_color: colorHit || null,
    dark_garment: dark,
    stitches,
    print_area,
    rush,
    // ISO (YYYY-MM-DD) so callers can put it straight into a due_date column. The phrase the
    // customer actually typed rides along for display, since "by the 8th" reads better than the
    // resolved date when we show them what we understood.
    due_hint: deadline.date,
    due_hint_text: deadline.text,
    notes: firstMeaningfulLine(t),
  }
}

const firstMeaningfulLine = (t) => String(t).split('\n').map((l) => l.trim())
  .filter((l) => l.length > 12 && !/^(hi|hey|hello|thanks|thank you|regards|best)\b/i.test(l))[0]?.slice(0, 180) || ''

/**
 * Only accept a model-supplied deadline that is a real ISO date and not already past — the
 * deterministic path guarantees both, and anything the model returns has to clear the same bar
 * before it can reach a DATE column.
 */
function acceptDue(v) {
  const t = String(v || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null
  const [y, m, d] = t.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null // e.g. 02-30
  return t >= new Date().toISOString().slice(0, 10) ? t : null
}

/**
 * Model-assisted intake, with the heuristic as the floor. The model only gets to add
 * confidence and catch phrasing the regex misses — if it's unreachable or returns junk,
 * the shop still gets a usable draft.
 */
export async function parseIntake(text) {
  const base = parseIntakeHeuristic(text)
  const status = await aiStatus()
  if (!status.available) return { ...base, ai_note: status.reason }

  const prompt = `Extract a custom-apparel order from this customer message. Reply with ONLY a JSON object, no prose.

Schema:
{"garment":string,"decoration":"Screen Print"|"DTF Transfer"|"Embroidery"|"UV DTF"|"Vinyl"|"Patch"|"Laser",
 "sizes":{"S":number,...},"locations":[{"name":string,"colors":number}],
 "dark_garment":boolean,"rush":boolean,"due_hint":string|null,"notes":string,"confidence":0-1}

Valid size keys: ${SIZES.join(', ')}. Only include sizes with a quantity. If no size breakdown is given, use {}.

Message:
"""
${String(text).slice(0, 4000)}
"""`

  try {
    const out = await callModel(prompt, { timeoutMs: 45000, maxTokens: 1024 })
    const j = extractJson(out)
    if (!j || typeof j !== 'object') return { ...base, ai_note: 'Model reply was not usable JSON; used the parser instead.' }
    const sizes = {}
    for (const [k, v] of Object.entries(j.sizes || {})) {
      const size = SIZES.find((s) => s.toLowerCase() === String(k).toLowerCase())
      if (size && Number(v) > 0) sizes[size] = Number(v)
    }
    const merged = {
      ...base,
      source: 'model',
      garment: j.garment || base.garment,
      decoration: DECOS.some((d) => d.name === j.decoration) ? j.decoration : base.decoration,
      sizes: Object.keys(sizes).length ? sizes : base.sizes,
      locations: Array.isArray(j.locations) && j.locations.length
        ? j.locations.slice(0, 5).map((l) => ({ name: String(l.name || 'Front').slice(0, 20), colors: Math.min(12, Math.max(1, Number(l.colors) || 1)) }))
        : base.locations,
      dark_garment: typeof j.dark_garment === 'boolean' ? j.dark_garment : base.dark_garment,
      rush: typeof j.rush === 'boolean' ? j.rush : base.rush,
      due_hint: acceptDue(j.due_hint) || base.due_hint,
      notes: j.notes || base.notes,
      confidence: typeof j.confidence === 'number' ? j.confidence : null,
    }
    // Keep the garment cost aligned with whatever garment we ended up with.
    const g = GARMENTS.find((x) => x.re.test(merged.garment))
    merged.garment_cost = g ? g.cost : base.garment_cost
    merged.total_pieces = Object.values(merged.sizes).reduce((s, n) => s + n, 0) || base.total_pieces
    return merged
  } catch (e) {
    invalidateStatus(aiConfig()) // a rejected key / expired session should be re-checked next call
    return { ...base, ai_note: `Model unavailable (${String(e.message).slice(0, 60)}); used the parser instead.` }
  }
}

/**
 * General single-shot generation, grounded by a system preamble. Used by the AI receptionist
 * to phrase a reply the deterministic engine has already decided the substance of. Returns
 * { text, source } and never throws — an unreachable model yields source:'unavailable'.
 */
export async function generate(prompt, { timeoutMs = 45000, max = 1200 } = {}) {
  const status = await aiStatus()
  if (!status.available) return { text: '', source: 'unavailable', ai_note: status.reason }
  try {
    return { text: (await callModel(prompt, { timeoutMs, maxTokens: Math.max(256, Math.ceil(max / 2)) })).slice(0, max), source: 'model' }
  } catch (e) {
    invalidateStatus(aiConfig())
    return { text: '', source: 'unavailable', ai_note: String(e.message).slice(0, 100) }
  }
}

/* ================= drafting a reply ================= */

export async function draftReply({ contact, context, intent }) {
  const status = await aiStatus()
  if (!status.available) return { text: '', source: 'unavailable', ai_note: status.reason }
  const prompt = `You are writing as the front desk of a custom apparel print shop. Write a short, warm, plain reply to ${contact?.name || 'the customer'}.
Intent: ${intent}
Context: ${context}
Rules: under 90 words. No marketing voice. No em dashes. Sign off with the shop name only. Reply with the message text and nothing else.`
  try {
    return { text: (await callModel(prompt, { timeoutMs: 45000, maxTokens: 700 })).slice(0, 1200), source: 'model' }
  } catch (e) {
    invalidateStatus(aiConfig())
    return { text: '', source: 'unavailable', ai_note: String(e.message).slice(0, 100) }
  }
}
