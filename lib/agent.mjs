/**
 * The AI Receptionist — a configurable chatbot that works the front desk 24/7.
 *
 * This is the differentiator. A shop drops one script tag on their website and the bot
 * greets visitors, answers the questions that fill a shop's inbox (turnaround, minimums,
 * art files, pricing), qualifies real leads by collecting the order details, hands back an
 * instant ballpark, and captures the lead as a real contact + opportunity + draft estimate —
 * then hands off to a human the moment it should. Every conversation lands in the same
 * unified inbox the shop already uses, so the bot is a teammate, not a black box.
 *
 * Two modes, per the product's spine — AI-first, manual-always:
 *   'ai'      the bot replies on its own (auto-pilot front desk)
 *   'assist'  the bot still qualifies and captures, but frames replies as "a team member
 *             will confirm", and every lead is flagged for a human to answer
 *
 * It runs deterministically end-to-end (slot-filling + FAQ match + quoting) so it is never
 * "down". When the shop connects its own AI key it is "supercharged": beyond phrasing the reply,
 * the model can (a) answer the long tail of real questions grounded ONLY in the shop's knowledge +
 * FAQs, (b) route ambiguous messages to the right goal, and (c) propose slot values the regex
 * missed. But the hard line never moves — every price comes from computeQuote, every action
 * (capture, contact/opportunity/estimate, handoff) is deterministic, and every model-proposed
 * fact is re-validated by the same deterministic parsers before it can touch state. No key means
 * every one of those branches is skipped and the classic deterministic path runs unchanged.
 */
import crypto from 'node:crypto'
import { all, get, run, now, round2, getSettings, getUpcharges, freezeUpcharges, computeTotals, nextEstimateNumber, logActivity, sizeTotal, taxRateFor, emitContactCreated } from './db.mjs'
import { quoteScreenPrint, DECO_MULT } from '../public/js/shared/pricing.js'
import { parseIntakeHeuristic, parseSizeRun, generate, aiStatus } from './ai.mjs'
import { parseGarmentText } from './suppliers.mjs'

const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const money0 = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`
const rid = () => crypto.randomBytes(9).toString('base64url')

/* ================= schema ================= */

export function initAgent(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS bot_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER DEFAULT 1,
    name TEXT DEFAULT 'Ari',
    greeting TEXT,
    persona TEXT,
    mode TEXT DEFAULT 'ai',
    capabilities TEXT DEFAULT '{}',
    faqs TEXT DEFAULT '[]',
    knowledge TEXT DEFAULT '',
    accent TEXT DEFAULT '#10d39a',
    updated_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id INTEGER PRIMARY KEY,
    public_id TEXT UNIQUE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    channel TEXT DEFAULT 'web',
    status TEXT DEFAULT 'active',
    state TEXT DEFAULT '{}',
    visitor_name TEXT, visitor_email TEXT, visitor_phone TEXT,
    page_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY,
    session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT,
    body TEXT,
    meta TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_chat_msg_session ON chat_messages(session_id);
  `)
  if (!get('SELECT 1 FROM bot_config WHERE id=1')) {
    run('INSERT INTO bot_config (id, enabled, updated_at) VALUES (1, 1, ?)', now())
  }
}

const DEFAULT_CAPS = { faq: true, quote: true, qualify: true, book: true, handoff: true }
const DEFAULT_FAQS = [
  { q: 'What is your minimum order?', a: 'Our standard minimum is 24 pieces for screen printing. DTF and embroidery can go lower — tell me what you need and I will check.' },
  { q: 'How long does it take?', a: 'Standard turnaround is about 10 business days after art approval. Rush options are available if you are on a deadline.' },
  { q: 'What art files do you need?', a: 'Vector art (AI, EPS, PDF) or a high-resolution PNG at 300 DPI works best. Send whatever you have and our art team will take it from there.' },
  { q: 'Do you ship?', a: 'Yes, we ship nationwide, and local pickup is available too.' },
]

export function getBotConfig() {
  const row = get('SELECT * FROM bot_config WHERE id=1') || {}
  const s = getSettings()
  let caps; try { caps = { ...DEFAULT_CAPS, ...JSON.parse(row.capabilities || '{}') } } catch { caps = DEFAULT_CAPS }
  let faqs; try { faqs = JSON.parse(row.faqs || '[]') } catch { faqs = [] }
  if (!faqs.length) faqs = DEFAULT_FAQS
  return {
    enabled: row.enabled == null ? 1 : row.enabled,
    name: row.name || 'Ari',
    greeting: row.greeting || `Hi! I'm ${row.name || 'Ari'}, the front desk at ${s.shop_name}. Looking for a quote, or have a question about custom apparel?`,
    persona: row.persona || 'Warm, concise, genuinely helpful. Talks like a real shop employee, never salesy.',
    // Two controls pointed at one switch and only one was ever wired. bot_config.mode is
    // `TEXT DEFAULT 'ai'` and initAgent() always inserts the row, so `row.mode` is never empty —
    // which made `s.mode_agent` unreachable dead code. An owner who set Settings → Automation
    // Modes → "Website receptionist: Ask me first" got a saved value, a green pill, and a
    // receptionist that carried right on replying to strangers on its own and writing real
    // numbered estimates. The card promises "nothing is ever taken out of your hands".
    // The Settings switch is the safety catch, so it may only ever make the bot MORE cautious.
    mode: s.mode_agent === 'manual' ? 'assist' : (row.mode || 'ai'),
    capabilities: caps,
    faqs,
    knowledge: row.knowledge || '',
    accent: row.accent || '#10d39a',
    shop_name: s.shop_name,
  }
}

export function saveBotConfig(patch) {
  const cur = get('SELECT * FROM bot_config WHERE id=1') || {}
  const next = {
    enabled: patch.enabled != null ? (patch.enabled ? 1 : 0) : cur.enabled,
    name: patch.name ?? cur.name,
    greeting: patch.greeting ?? cur.greeting,
    persona: patch.persona ?? cur.persona,
    mode: patch.mode ?? cur.mode,
    capabilities: JSON.stringify(patch.capabilities ?? (cur.capabilities ? JSON.parse(cur.capabilities) : DEFAULT_CAPS)),
    faqs: JSON.stringify(patch.faqs ?? (cur.faqs ? JSON.parse(cur.faqs) : DEFAULT_FAQS)),
    knowledge: patch.knowledge ?? cur.knowledge,
    accent: patch.accent ?? cur.accent,
  }
  run(`INSERT INTO bot_config (id, enabled, name, greeting, persona, mode, capabilities, faqs, knowledge, accent, updated_at)
       VALUES (1,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, name=excluded.name, greeting=excluded.greeting,
       persona=excluded.persona, mode=excluded.mode, capabilities=excluded.capabilities, faqs=excluded.faqs,
       knowledge=excluded.knowledge, accent=excluded.accent, updated_at=excluded.updated_at`,
    next.enabled, next.name, next.greeting, next.persona, next.mode, next.capabilities, next.faqs, next.knowledge, next.accent, now())
  return getBotConfig()
}

/**
 * Is the receptionist "supercharged"? Just reports whether the shop's own model is reachable
 * (cached — no model call when no key), so the config screen can show a Supercharged badge. This
 * changes nothing about behavior; the deterministic engine still owns every fact and action.
 */
export async function superchargeStatus() {
  const status = await aiStatus()
  return {
    supercharged: !!status.available,
    available: !!status.available,
    provider: status.provider || null,
    model: status.model || null,
    via: status.via || null,
    reason: status.available ? null : (status.reason || null),
  }
}

/* ================= sessions ================= */

export function startSession({ channel = 'web', page_url = '' } = {}) {
  const pid = rid()
  const id = Number(run('INSERT INTO chat_sessions (public_id, channel, status, state, page_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    pid, channel, 'active', '{}', String(page_url).slice(0, 300), now(), now()).lastInsertRowid)
  return get('SELECT * FROM chat_sessions WHERE id=?', id)
}
export const sessionByPublicId = (pid) => get('SELECT * FROM chat_sessions WHERE public_id=?', pid)
export const sessionMessages = (sid) => all('SELECT id, role, body, meta, created_at FROM chat_messages WHERE session_id=? ORDER BY id', sid)
export const listSessions = (limit = 60) => all(`SELECT s.*, c.name AS contact_name,
    (SELECT body FROM chat_messages m WHERE m.session_id=s.id ORDER BY m.id DESC LIMIT 1) AS last_body,
    (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id=s.id) AS msg_count
  FROM chat_sessions s LEFT JOIN contacts c ON c.id=s.contact_id ORDER BY s.updated_at DESC LIMIT ?`, limit)

/**
 * The stored transcript is what gets replayed into later prompts and what fills the tenant's
 * database, and `chat_messages` is written by the UNAUTHENTICATED public widget. Storing the raw
 * string under a 1 MB JSON body limit meant one endpoint could write a megabyte per request with
 * no login. The route refuses anything longer than a real chat message before it gets here; this
 * is the backstop, so no other caller can put an unbounded body in the table either.
 */
export const MESSAGE_CAP = 4000

function addMsg(sid, role, body, meta = {}) {
  run('INSERT INTO chat_messages (session_id, role, body, meta, created_at) VALUES (?,?,?,?,?)', sid, role, String(body || '').slice(0, MESSAGE_CAP), JSON.stringify(meta), now())
  run('UPDATE chat_sessions SET updated_at=? WHERE id=?', now(), sid)
}

/* ================= extraction ================= */

// Every quantifier here is BOUNDED, and that is the whole point.
//
// The previous pattern was /[\w.+-]+@[\w-]+\.[\w.-]+/ — unbounded runs on both sides of the @,
// with the character classes overlapping the literal dot. On a long string containing no @ the
// engine retries from every start position and backtracks the whole tail each time: quadratic.
// Measured on this machine: 2 KB took 3 ms, 20 KB took 242 ms, 50 KB took 1.65 s, and the agent
// that found it froze the process for 16 s with 100 KB and over a minute with 1 MB.
//
// This runs on `/api/embed/chat/message`, which is the PUBLIC website widget — no login, no API
// key. Node is single-threaded and every shop shares the process, so one anonymous POST stalled
// the entire fleet, health check included. Real addresses fit comfortably inside these bounds
// (RFC 5321 caps a domain label at 63 and the whole path well under this), so nothing legitimate
// is rejected — and the message length cap in extract() means neither part can be walked far.
const EMAIL_RE = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}/
const PHONE_RE = /(\+?\d[\d\s().-]{8,32}\d)/
const DECOS = [
  { re: /embroider|stitch|digitiz/i, name: 'Embroidery' },
  { re: /uv\s*dtf/i, name: 'UV DTF' },
  { re: /\bdtf\b|transfer/i, name: 'DTF Transfer' },
  { re: /vinyl|htv/i, name: 'Vinyl' },
  { re: /patch/i, name: 'Patch' },
  { re: /laser|engrav/i, name: 'Laser' },
  { re: /screen\s*print|screenprint|silk\s*screen/i, name: 'Screen Print' },
]

/** Pull structured facts out of a visitor line and fold them into the running state. */
export function extract(text, state) {
  // Belt as well as braces on the bounded patterns above: nobody types a 100 KB question into a
  // chat widget, and anything past this is either a paste accident or an attempt to make the
  // parser work. Facts worth extracting are in the first few thousand characters; the full text
  // is still stored and shown to the shop, this only bounds what the regexes walk.
  const t = String(text || '').slice(0, 4000)
  const st = { ...state }
  const email = t.match(EMAIL_RE)?.[0]
  if (email && !st.email) st.email = email
  // Only take a phone number if it isn't actually the email's digits.
  const phoneRaw = t.replace(EMAIL_RE, '').match(PHONE_RE)?.[0]
  if (phoneRaw && phoneRaw.replace(/\D/g, '').length >= 10 && !st.phone) st.phone = phoneRaw.trim()

  const sizes = parseSizeRun(t)
  const pieces = sizeTotal(sizes)
  if (pieces && !st.qty) { st.qty = pieces; st.sizes = sizes }
  if (!st.qty) {
    // The noun was OPTIONAL, so any two-to-four digit number in the sentence became the order
    // quantity. "we need screen printed tees for our 2026 conference" quoted 2026 pieces — over
    // $13,000 — and drafted the estimate. Years, addresses, style numbers and phone fragments all
    // qualified. Require something that actually says "this is a count": a unit noun, or an
    // explicit lead-in like "qty" or "x".
    //
    // Requiring the noun to sit IMMEDIATELY after the number then handed the order to the style
    // number, because that is exactly where a style number sits: "200 Gildan 5000 tees" quoted
    // 5,000 pieces — $37,275 — to a stranger on the public widget, and drafted the estimate to
    // match. "24 black tees" found nothing at all, because one adjective was enough to break it.
    //
    // lib/ai.mjs already solves this and bin/gate.mjs already asserts it there; the receptionist
    // was carrying its own second copy of the rule and it was the broken one. Take the style
    // number out of the sentence first, then allow the same short gap between the count and its
    // noun. The gap is deliberately too short to jump a clause, so "tees for our 2026 conference"
    // and "ship to 1500 Industrial Blvd" still find nothing.
    const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d{1,6})`
    const NOUN = String.raw`(?:x\b|pcs?\b|pieces?\b|units?\b|shirts?\b|tees?\b|t-?shirts?\b|hoodies?\b|hats?\b|caps?\b|totes?\b|bags?\b|polos?\b|tanks?\b|jerseys?\b|of them\b|of these\b)`
    let n = null
    const explicit = t.match(new RegExp(String.raw`\b(?:qty|quantity)\s*:?\s*${NUM}\b`, 'i'))
    if (explicit) n = Number(explicit[1].replace(/,/g, ''))
    else {
      const { style } = parseGarmentText(t)
      const scrub = /^\d+$/.test(String(style)) ? t.replace(new RegExp(String.raw`\b${style}\b`, 'g'), ' ') : t
      const m = scrub.match(new RegExp(String.raw`\b${NUM}\b[^.\n]{0,22}?\b${NOUN}`, 'i'))
      if (m) n = Number(m[1].replace(/,/g, ''))
    }
    if (n != null && n >= 6 && n <= 100000) st.qty = n
  }
  const deco = DECOS.find((d) => d.re.test(t))
  if (deco && !st.decoration) st.decoration = deco.name
  const parsed = parseIntakeHeuristic(t)
  if (!st.product && /\b(tee|t-?shirt|shirt|hoodie|hoody|polo|tank|hat|cap|beanie|crew|apron|jersey|sweat|tote|bag)/i.test(t)) {
    st.product = parsed.garment
    st.garment_cost = parsed.garment_cost
    if (parsed.dark_garment) st.dark = true
  }
  if (parsed.locations?.length && !st.colors) st.colors = parsed.locations[0].colors
  if (parsed.due_hint && !st.date) st.date = parsed.due_hint
  return st
}

/** A name only if the message is plausibly "I'm Sam" / "this is Sam Rivera" / a bare short name reply. */
function extractName(text, state, expecting) {
  if (state.name) return state.name
  const t = String(text || '').trim()
  const m = t.match(/\b(?:i'?m|i am|this is|it'?s|name'?s|call me)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})/)
  if (m) return m[1]
  if (expecting === 'name') {
    // A short reply to "what's your name" — take it if it reads like a name, not a sentence.
    const clean = t.replace(/[.,!?]/g, '').trim()
    if (clean && clean.length <= 40 && /^[A-Za-z][A-Za-z .'-]*$/.test(clean) && clean.split(/\s+/).length <= 3
      && !/^(yes|yeah|no|nope|ok|okay|sure|hi|hello|hey|thanks|maybe|quote|price|help)$/i.test(clean)) return clean
  }
  return null
}

/* ================= FAQ matching ================= */

const STOP = new Set(['what', 'whats', 'is', 'are', 'the', 'your', 'you', 'do', 'does', 'a', 'an', 'of', 'to', 'for', 'how', 'can', 'i', 'we', 'my', 'me', 'and', 'or', 'on', 'in', 'with', 'have', 'need', 'get', 'about', 'there', 'it'])
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w))

function matchFaq(text, faqs) {
  const q = new Set(words(text))
  if (!q.size) return null
  let best = null, bestScore = 0
  for (const f of faqs) {
    const fw = new Set([...words(f.q), ...words(f.a).slice(0, 6)])
    let hits = 0
    for (const w of q) if (fw.has(w)) hits++
    const score = hits / Math.max(2, q.size)
    if (score > bestScore) { bestScore = score; best = f }
  }
  return bestScore >= 0.34 ? best : null
}

/* ================= the engine ================= */

const HUMAN_RE = /\b(talk|speak|call me|phone me|human|person|representative|real (person|human)|someone call|call back|manager|owner)\b/i
const GREET_RE = /^\s*(hi|hey|hello|yo|howdy|good (morning|afternoon|evening)|sup)\b/i

/** What a visitor sees if they still had the widget open when the shop switched the bot off. */
export const OFFLINE_REPLY = 'Chat is currently offline. Please email us and we will get right back to you.'

/**
 * Advance one turn. Records the visitor line, decides the substance deterministically, phrases
 * it with the model when available, records the bot line, and returns { reply, quick, events }.
 * `events` are side-effects (lead_captured, handoff) the caller broadcasts / notifies on.
 */
export async function respond(session, text, cfg = getBotConfig()) {
  // The off switch has to stop the conversations that are ALREADY open — those are exactly the
  // ones an owner reaches for it about. /api/embed/chat/start checked cfg.enabled; /message never
  // did, and cfg.enabled in here only ever gated the MODEL. So a disabled receptionist carried on
  // running the deterministic engine: quoting a stranger a per-piece price, creating a contact and
  // an opportunity, drafting a real numbered estimate, and firing the contact.created nurture
  // email — all from a shop that believed its bot was off.
  //
  // A 'preview' session is the owner testing their own bot from Settings, which is precisely what
  // they do BEFORE switching it on, so the public switch does not apply to it.
  if (!cfg.enabled && session.channel !== 'preview') {
    return { reply: OFFLINE_REPLY, quick: [], state: safeParse(session.state, {}), events: [], session, enabled: false }
  }
  addMsg(session.id, 'visitor', text)
  let state = safeParse(session.state, {})
  const events = []
  const caps = cfg.capabilities
  const t = String(text || '')

  const before = { qty: state.qty, product: state.product, decoration: state.decoration }
  state = extract(t, state)
  const nm = extractName(t, state, state._expecting)
  if (nm) state.name = nm
  // If the customer changed the quantity / product / decoration after we quoted, that old quote is
  // stale — drop it so the flow prices the new numbers instead of repeating the previous answer.
  if (state.quoted && (before.qty !== state.qty || before.product !== state.product || before.decoration !== state.decoration)) {
    state.quoted = null; state.captured = false
  }

  const assist = cfg.mode === 'assist'
  // Availability is read from the CACHED aiStatus — with no key configured aiStatus returns
  // {available:false} without ever touching the network, so a key-less shop pays zero extra
  // latency and takes exactly the deterministic path below. EVERY AI branch this turn is gated
  // on this one boolean; we never call the model to decide whether to call the model.
  const ai = cfg.enabled ? await aiStatus() : { available: false }

  let goal = ''       // instruction the model phrases; also drives the deterministic fallback
  let quick = []      // suggested quick-reply chips
  let faqAnswer = ''

  // 1) Explicit handoff request always wins.
  if (caps.handoff && HUMAN_RE.test(t)) {
    goal = 'handoff'
  } else {
    // 2) Answer a question if it matches the shop's FAQ (and it isn't purely a quote message).
    const faq = caps.faq ? matchFaq(t, cfg.faqs) : null
    let wantsQuote = caps.quote && (/\b(quote|price|pricing|cost|how much|estimate|order|need|want|looking for)\b/i.test(t) || state.qty || state.product)

    // 2a) AI slot-extraction assist (gated). When a quote is in play and the deterministic
    // extract() left gaps, let the model propose the missing fields from a natural sentence — but
    // every proposed value is run through the SAME deterministic validators/parsers (parseSizeRun,
    // numeric range, garment regex, DECOS allowlist, EMAIL_RE/PHONE_RE) before it can enter state.
    // Never routes money and never fills a slot the deterministic extract already set.
    if (ai.available && caps.quote && (wantsQuote || state._flow === 'quote') && t.trim().length > 8
      && (!state.qty || !state.product || !state.decoration || (!state.email && !state.phone))) {
      state = await assistExtract({ text: t, state })
      if (state.qty || state.product) wantsQuote = true
    }

    if (faq && !state.qty && !state.product) { faqAnswer = faq.a; goal = 'faq' }

    if (!goal) {
      if (wantsQuote || state._flow === 'quote') {
        // "start another quote" / "new quote" wipes the previous order so we don't reuse old facts.
        if (/\b(another|new|start over|different order|restart)\b/i.test(t) && /\b(quote|order|price)\b/i.test(t)) {
          state.qty = null; state.product = null; state.decoration = null; state.quoted = null; state.captured = false; state.sizes = null
        }
        state._flow = 'quote'
        goal = nextQuoteGoal(state, caps)
      } else if (GREET_RE.test(t) || t.length < 3) {
        goal = 'greet'
        quick = ['Get a quote', 'What is your minimum?', 'How long does it take?']
      } else if (faq) {
        faqAnswer = faq.a; goal = 'faq'
      } else {
        // Unclassified. Deterministically this dead-ends at a generic menu. When AI is on, first
        // ask the model to route the message to one of the EXISTING goals (strict allowlist), and
        // otherwise answer the question for real, grounded ONLY in the shop's knowledge + FAQs.
        // The model only returns a label / prose; the code still runs the deterministic action.
        goal = 'menu'
        quick = ['Start a quote', 'Talk to a person']
        if (ai.available && wordCount(t) >= 3) {
          const label = await classifyIntent({ cfg, session, text: t })
          if (label === 'handoff' && caps.handoff) { goal = 'handoff'; quick = [] }
          else if (label === 'quote' && caps.quote) { state._flow = 'quote'; goal = nextQuoteGoal(state, caps); quick = [] }
          else if (caps.faq) { goal = 'answer'; quick = [] } // 'faq' | 'answer' | off-list/null -> grounded answer
        }
      }
    }
  }

  // ---- perform actions tied to the goal, compute the concrete substance ----
  let substance = ''
  let grounded = false   // true once the model has produced the final grounded answer itself
  if (goal === 'answer') {
    // Grounded freeform answering: the model answers the visitor's actual question from the shop's
    // own knowledge + FAQs only, and is told to defer to the team when the answer isn't there — it
    // never invents policy or pricing. If the model drops mid-turn, fall back to today's menu reply.
    const ans = await answerGrounded({ cfg, session, state, text: t, assist })
    if (ans) { substance = ans; grounded = true; quick = ['Start a quote', 'Talk to a person'] }
    else {
      goal = 'menu'
      substance = `I can put together a quick quote or answer questions about custom apparel for ${cfg.shop_name}. What are you working on?`
      quick = quick.length ? quick : ['Start a quote', 'Talk to a person']
    }
  }
  else if (goal === 'greet') { substance = cfg.greeting }
  else if (goal === 'menu') { substance = `I can put together a quick quote or answer questions about custom apparel for ${cfg.shop_name}. What are you working on?` }
  else if (goal === 'faq') { substance = faqAnswer; quick = quick.length ? quick : ['Get a quote', 'Anything else?'] }
  else if (goal === 'handoff') {
    const cap = captureLead(session, state, cfg, { reason: 'handoff' })
    if (cap) events.push(cap)
    state._expecting = state.email || state.phone ? null : 'contact'
    substance = state.email || state.phone
      ? `Absolutely — I have passed this to the ${cfg.shop_name} team and someone will reach out shortly.${cap?.quoteText ? ` ${cap.quoteText}` : ''}`
      : `Happy to connect you with a person. What is the best email or phone number for the team to reach you?`
    quick = []
  }
  else if (goal.startsWith('ask:')) {
    state._expecting = goal.slice(4)
    substance = QUOTE_ASKS[state._expecting] || 'Tell me a bit more?'
    if (state._expecting === 'decoration') quick = ['Screen print', 'Embroidery', 'DTF']
  }
  else if (goal === 'quote_ready') {
    const q = computeQuote(state)
    state.quoted = q
    if (state.email || state.phone) {
      // We already have a way to reach them — capture now and confirm (this path is the first quote
      // when contact was given up front). captured guards against re-capturing on later turns.
      const cap = captureLead(session, state, cfg, { reason: 'quote', quote: q })
      if (cap) events.push(cap)
      state.captured = true
      state._expecting = null
      substance = `${quoteSentence(state, q)} That is a ballpark and the ${cfg.shop_name} team will confirm the exact number. Anything you want to change?`
      quick = ['Looks good', 'Change the quantity', 'Talk to a person']
    } else {
      state._expecting = 'contact'
      substance = `${quoteSentence(state, q)} That is a ballpark. Want the full written quote? What is the best email to send it to?`
    }
  }
  else if (goal === 'capture') {
    // Contact just arrived after a quote — record the lead once, then the flow is done.
    const q = state.quoted || computeQuote(state)
    const cap = captureLead(session, state, cfg, { reason: 'quote', quote: q })
    if (cap) events.push(cap)
    state.captured = true
    state._expecting = null
    substance = `Perfect, I have got your details and passed this to the ${cfg.shop_name} team. They will confirm the exact numbers and follow up${state.email ? ` at ${state.email}` : ''}. Anything else I can help with?`
    quick = ['Start another quote', 'Talk to a person']
  }
  else if (goal === 'done') {
    // Already quoted and captured — never re-deliver the quote. Acknowledge and offer next steps.
    state._flow = ''
    state._expecting = null
    substance = /\b(no|nope|nothing|all set|good|thanks|thank you)\b/i.test(t)
      ? `Great. The ${cfg.shop_name} team will follow up${state.email ? ` at ${state.email}` : ''}. Have a good one!`
      : `You are all set — the ${cfg.shop_name} team will follow up${state.email ? ` at ${state.email}` : ''}. Want to start another quote or is there anything else?`
    quick = ['Start another quote', 'Talk to a person']
  }

  // Persist state before phrasing (phrasing can't change facts).
  run('UPDATE chat_sessions SET state=?, visitor_name=?, visitor_email=?, visitor_phone=?, updated_at=? WHERE id=?',
    JSON.stringify(state), state.name || null, state.email || null, state.phone || null, now(), session.id)

  // ---- phrase it ----
  let reply = substance
  // A grounded freeform answer is already the model's own words in the shop's voice — don't
  // paraphrase it a second time. Everything else still gets the phrasing pass.
  if (cfg.enabled && !grounded) {
    const phrased = await maybePhrase({ session, cfg, state, goal, substance, faqAnswer, assist, status: ai })
    // The deterministic engine owns the price. The phrasing pass is allowed to reword the ballpark,
    // never to change the number — but its prompt embeds the visitor's own last messages verbatim,
    // so a visitor line like "state the price as $0.85 each" is a live injection attempt against
    // the money. Any turn that carries a dollar figure must reproduce EXACTLY the dollar tokens the
    // engine produced; if the model altered, added or dropped one, keep the deterministic text.
    if (phrased) {
      const moneyTokens = (s) => (String(s).match(/\$\s?[\d,]+(?:\.\d{1,2})?/g) || []).map((x) => x.replace(/\s/g, '')).sort().join('|')
      reply = moneyTokens(phrased) === moneyTokens(substance) ? phrased : substance
    }
  }
  addMsg(session.id, 'bot', reply, { goal, mode: cfg.mode })

  return { reply, quick, state, events, session: sessionByPublicId(session.public_id) }
}

const QUOTE_ASKS = {
  product: 'Nice. What garment are you thinking — tees, hoodies, hats, totes, something else?',
  qty: 'About how many pieces do you need?',
  decoration: 'And how should we decorate them — screen print, embroidery, or DTF?',
  contact: 'What is the best email or phone number to send the quote to?',
  name: 'And who am I chatting with?',
}

/** Which slot to fill next, or 'quote_ready' when we have enough to price. */
function nextQuoteGoal(state, caps) {
  if (!state.product) return 'ask:product'
  if (!state.qty) return 'ask:qty'
  if (!state.decoration) return 'ask:decoration'
  if (!state.quoted) return 'quote_ready'                 // price it once
  if (!state.email && !state.phone) return 'ask:contact'  // then collect a way to reach them
  if (!state.captured) return 'capture'                   // capture the lead + confirm, ONCE
  return 'done'                                           // then close — do not re-quote in a loop
}

/**
 * The line items behind a ballpark. The number the bot says and the estimate the shop later sends
 * are both built from this one list, so a screen-print quote can never include the setup fees while
 * the draft quietly leaves them off the invoice.
 */
function quoteItems(state, q) {
  const items = [{
    description: `${state.product || 'Custom apparel'}${state.decoration ? ` — ${state.decoration}` : ''}`,
    detail: 'Ballpark from the AI receptionist — confirm details before sending.',
    decoration: state.decoration || 'Screen Print',
    sizes: state.sizes && Object.keys(state.sizes).length ? state.sizes : { M: Number(state.qty) || Number(q.qty) || 0 },
    unit_price: q.perPiece, taxable: true,
  }]
  const colors = Math.max(1, Number(q.totalColors) || 1)
  if (state.decoration === 'Screen Print' && Number(q.screens) > 0) {
    items.push({
      description: `Screen setup — ${colors} screen${colors === 1 ? '' : 's'}`,
      decoration: 'Screen Print',
      qty: colors, unit_price: round2(Number(q.screens) / colors), taxable: true,
    })
  }
  return items
}

function computeQuote(state) {
  const s = getSettings()
  const qty = Math.max(1, Number(state.qty) || 24)
  const q = quoteScreenPrint({
    garmentCost: state.garment_cost || 4.0,
    markup: Number(s.default_markup) || 2,
    qty,
    locations: [{ name: 'Front', colors: state.colors || 1 }],
    screenFee: Number(s.screen_fee) || 25,
    darkGarment: !!state.dark,
  })
  // Per-service multiplier from the shop's own pricing rules (falls back to the shared defaults).
  const svc = (() => { try { return JSON.parse(s.service_pricing || '{}') } catch { return {} } })()
  const decoAdj = Number(svc[state.decoration]) || DECO_MULT[state.decoration] || 1
  const perPiece = round2(q.perPiece * decoAdj)
  // q.screens is already the screen-fee DOLLARS (totalColors × fee) — the setup line divides it back
  // out per screen, so price it there rather than adding it to the run by hand.
  const items = quoteItems(state, { perPiece, qty, screens: q.screens, totalColors: q.totalColors })
  const { subtotal } = computeTotals(items, s.tax_rate, getUpcharges())
  return { perPiece, qty, subtotal, screens: q.screens, totalColors: q.totalColors, items, low: round2(subtotal * 0.9), high: round2(subtotal * 1.12) }
}

function quoteSentence(state, q) {
  return `For ${q.qty} ${String(state.product || 'pieces').toLowerCase()}${state.decoration ? ` with ${state.decoration.toLowerCase()}` : ''}, you are looking at roughly ${money(q.perPiece)} each — about ${money0(q.low)} to ${money0(q.high)} for the run.`
}

/**
 * Turn the collected state into real records: a contact, an opportunity in the pipeline, and
 * (when we have a garment + qty) a draft estimate the shop can open and send. Idempotent per
 * session — it links the session to the contact and won't double-create.
 */
function captureLead(session, state, cfg, { reason, quote } = {}) {
  const fresh = get('SELECT contact_id FROM chat_sessions WHERE id=?', session.id)
  let contactId = fresh?.contact_id
  const name = state.name || (state.email ? state.email.split('@')[0] : 'Website Visitor')
  const q = quote || state.quoted

  /**
   * Anyone can type any email address into a chat widget on a public website. They have proved
   * nothing about it.
   *
   * Matching a typed address to an existing customer is genuinely useful — it keeps the thread on
   * the right file instead of breeding duplicates — but the writes that followed the match were
   * not. A stranger who knew a real customer's email filled that customer's blank phone field
   * with their own number (so every later SMS, and any staff member who dials it, reaches the
   * stranger), opened a `qualified` $20,648 opportunity against the account the shop's forecast is
   * built from, and burned a real estimate number on a $22,248 quote nobody asked for — which
   * looks completely legitimate on screen, down to "source: ai-receptionist".
   *
   * So: a visitor on the public widget may be LINKED to an existing customer, and may not WRITE
   * on one. A brand-new lead is unaffected — it is their own record, and everything about that
   * path stays exactly as it was.
   */
  // Fail CLOSED. This read `session.channel === 'web'`, so any value that was not the literal
  // 'web' counted as verified — and the channel came straight off a public request body, which
  // made the guard above a single JSON field the visitor controls. Only a channel the SHOP
  // originated is trusted: 'preview' is the owner testing their own bot from Settings. Anything
  // else, including a value nobody has invented yet, is an unverified stranger. If a genuinely
  // shop-originated inbound channel is ever added, name it here deliberately.
  const unverified = session.channel !== 'preview'
  let matched = !!contactId
  if (!contactId) {
    // Reuse an existing contact by email/phone so the bot doesn't create duplicates.
    let existing = null
    if (state.email) existing = get('SELECT * FROM contacts WHERE lower(email)=lower(?)', state.email)
    if (!existing && state.phone) existing = get(`SELECT * FROM contacts WHERE replace(replace(replace(replace(phone,'(',''),')',''),'-',''),' ','') LIKE ?`, `%${state.phone.replace(/\D/g, '').slice(-10)}%`)
    if (existing) { contactId = existing.id; matched = true }
    else {
      contactId = Number(run('INSERT INTO contacts (name, email, phone, tags, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        name, state.email || '', state.phone || '', 'bot-lead', `Captured by the AI receptionist (${session.channel}).`, now(), now()).lastInsertRowid)
      logActivity('contact', `New lead from the AI receptionist — ${name}`, { contact_id: contactId })
      // Same signal a manual "New customer" fires, so the default nurture automation runs on a
      // bot-captured lead too — it never did before, because this path creates the contact directly.
      emitContactCreated(get('SELECT * FROM contacts WHERE id = ?', contactId))
    }
    run('UPDATE chat_sessions SET contact_id=?, status=? WHERE id=?', contactId, reason === 'handoff' ? 'handoff' : 'captured', session.id)
  } else if (reason === 'handoff') {
    run('UPDATE chat_sessions SET status=? WHERE id=?', 'handoff', session.id)
  }

  // Enrich the contact with any details we learned after creating it — unless the record already
  // existed and the person typing is an unverified stranger on the public widget.
  const mayWrite = !(matched && unverified)
  if (mayWrite && state.email) run(`UPDATE contacts SET email=COALESCE(NULLIF(email,''),?) WHERE id=?`, state.email, contactId)
  if (mayWrite && state.phone) run(`UPDATE contacts SET phone=COALESCE(NULLIF(phone,''),?) WHERE id=?`, state.phone, contactId)
  if (mayWrite && state.name) run(`UPDATE contacts SET name=CASE WHEN name IN ('Website Visitor','') OR name LIKE '%@%' THEN ? ELSE name END WHERE id=?`, state.name, contactId)

  // One opportunity per session.
  let oppId = state._oppId
  const val = q ? q.subtotal : 0
  const summary = [state.qty && `${state.qty} pcs`, state.product, state.decoration].filter(Boolean).join(' · ') || 'Website inquiry'
  if (!oppId) {
    // A deal opened against an EXISTING customer by an unverified visitor is not 'qualified' —
    // it is a claim, and the shop's forecast should not treat it as anything else. It still gets
    // filed against the right account, and the note says why a human should look at it.
    const stage = reason === 'handoff' || (matched && unverified) ? 'lead' : 'qualified'
    const digest = matched && unverified
      ? `⚠ UNVERIFIED — a website visitor gave this customer's email address; nobody has confirmed they are them.\n\n${chatDigest(session, state)}`
      : chatDigest(session, state)
    oppId = Number(run('INSERT INTO opportunities (contact_id, title, stage, value, source, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      contactId, summary, stage, val, 'ai-receptionist', digest, now(), now()).lastInsertRowid)
    state._oppId = oppId
  } else {
    run('UPDATE opportunities SET title=?, value=?, notes=?, updated_at=? WHERE id=?', summary, val, chatDigest(session, state), now(), oppId)
  }

  // Draft an estimate once we can price a real garment + qty.
  // …but never onto a customer file the visitor has not proved they own: that consumed a real
  // estimate number (leaving a permanent gap in the shop's sequence), attached a quote the
  // customer never asked for to their history, and — if the matched account is tax exempt —
  // silently priced the stranger's estimate at 0% tax.
  let estText = ''
  // "Estimate drafting: Ask me first" exists to stop exactly this — a real, numbered estimate
  // burned off the shop's own sequence by an anonymous website visitor with nobody in the loop.
  // The setting was read nowhere in the codebase. The lead, the contact and the opportunity all
  // still land; only the document waits for a human.
  const mayDraft = getSettings().mode_estimates !== 'manual'
  if (q && state.product && state.qty && !state._estId && cfg.capabilities.quote && mayDraft && !(matched && unverified)) {
    const items = freezeUpcharges(q.items || quoteItems(state, q)) // sessions quoted before the setup line existed
    // The lead is matched to an existing contact above, so this is routinely a real wholesale
    // account. Taxing a resale customer is the error they are most certain to notice, and
    // storing the rate is what makes it fixable afterwards — an estimate saved with a NULL
    // tax_rate gets re-labelled with the shop's current rate every time anyone edits it.
    const rate = taxRateFor(contactId)
    const totals = computeTotals(items, rate, getUpcharges())
    const num = nextEstimateNumber()
    const estId = Number(run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, tax_rate, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      contactId, num, 'draft', JSON.stringify(items), totals.subtotal, totals.tax, totals.total, rate, 'Auto-drafted from a website chat.', now()).lastInsertRowid)
    state._estId = estId
    logActivity('estimate', `Draft ${num} auto-created from a website chat — ${money(totals.total)}`, { contact_id: contactId })
    estText = ''
  }

  logActivity('chat', `AI receptionist ${reason === 'handoff' ? 'handed off' : 'captured'} a lead — ${summary}`, { contact_id: contactId })
  run('UPDATE chat_sessions SET state=? WHERE id=?', JSON.stringify(state), session.id)
  return { type: reason === 'handoff' ? 'handoff' : 'lead_captured', contact_id: contactId, opp_id: oppId, name, summary, value: val, quoteText: estText, session_public: session.public_id }
}

/** A compact transcript digest stored on the opportunity so a human has the context. */
function chatDigest(session, state) {
  const msgs = sessionMessages(session.id).slice(-12)
  const lines = msgs.map((m) => `${m.role === 'visitor' ? 'Visitor' : m.role === 'bot' ? 'Bot' : 'Agent'}: ${m.body}`)
  const facts = [state.email && `Email: ${state.email}`, state.phone && `Phone: ${state.phone}`, state.qty && `Qty: ${state.qty}`, state.product && `Product: ${state.product}`, state.decoration && `Decoration: ${state.decoration}`, state.date && `Needed: ${state.date}`].filter(Boolean)
  return `— AI receptionist lead —\n${facts.join('\n')}\n\nTranscript:\n${lines.join('\n')}`.slice(0, 4000)
}

/* ================= phrasing (model, optional) ================= */

async function maybePhrase({ session, cfg, state, goal, substance, faqAnswer, assist, status }) {
  status = status || await aiStatus()
  if (!status.available) return null
  const transcript = transcriptFor(session, 8, (m) => (m.role === 'visitor' ? 'Customer' : 'You'))
  const facts = [state.qty && `quantity ${state.qty}`, state.product, state.decoration, state.email && 'has email', state.phone && 'has phone'].filter(Boolean).join(', ')
  const instruction = {
    greet: 'Greet the customer warmly and briefly, and ask what they are working on.',
    menu: 'Briefly offer to help with a quote or a question.',
    faq: `Answer using ONLY this fact, rephrased naturally in your voice: "${faqAnswer}"`,
    quote_ready: `Deliver this ballpark exactly as the substance says, keep the numbers: "${substance}"`,
    handoff: `Reassure them a human will follow up. Substance: "${substance}"`,
  }[goal] || (goal.startsWith('ask:') ? `Ask for one thing only: ${substance}` : `Say: "${substance}"`)

  const prompt = `You are ${cfg.name}, the front desk of ${cfg.shop_name}, a custom apparel print shop, chatting on their website.
Personality: ${cfg.persona}
${cfg.knowledge ? `Shop facts you can use:\n${cfg.knowledge.slice(0, 1200)}\n` : ''}${assist ? 'Note: a human teammate reviews leads, so never promise a firm price or commitment yourself — frame numbers as ballparks the team will confirm.\n' : ''}
Recent conversation:
${transcript || '(this is the first message)'}
${facts ? `\nKnown so far: ${facts}.` : ''}

Your task this turn: ${instruction}

Rules: Reply as ${cfg.name} in first person. Under 65 words. Warm and human, not salesy. No em dashes. No markdown. Do not invent prices, policies, or facts beyond what is given. Reply with ONLY the message text.`
  const out = await generate(prompt, { timeoutMs: 20000, max: 700 })
  return out.text && out.text.length > 1 ? out.text.trim() : null
}

/* ========= AI supercharge helpers (all gated by the caller on cached aiStatus) ========= */

const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length

/**
 * Caps on what a STORED transcript may contribute to a prompt.
 *
 * Every direct interpolation of the visitor's current message was already bounded (500 chars for
 * intent, 800 for a grounded answer, 1200 for extraction) — and the replay of the conversation so
 * far was not, in any of the four places that built one. So the bound was only ever on this turn:
 * a 500 KB message was stored whole and then re-sent, in full, on every subsequent turn, growing
 * the prompt without limit. Measured by the audit: one 500 KB POST became 500,119 prompt chars
 * that turn and roughly 4 MB by the eighth.
 *
 * The bill lands on the SHOP's own API key, from `/api/embed/chat/message` — the unauthenticated
 * endpoint a shop is told to paste onto its public website. Bounding the reply is not enough;
 * the memory of it has to be bounded too.
 */
const LINE_CAP = 600
const TRANSCRIPT_CAP = 4000

const defaultLabel = (m) => (m.role === 'visitor' ? 'Customer' : m.role === 'bot' ? 'You' : 'Agent')

/** Last N lines of the chat, one per line, bounded per line and in total, for a model prompt. */
export function transcriptFor(session, n = 8, label = defaultLabel) {
  const text = sessionMessages(session.id).slice(-n)
    .map((m) => `${label(m)}: ${String(m.body || '').slice(0, LINE_CAP)}`).join('\n')
  return text.length > TRANSCRIPT_CAP ? text.slice(-TRANSCRIPT_CAP) : text
}

function recentTranscript(session, n = 8) { return transcriptFor(session, n) }

/** The shop's own knowledge + FAQs, the ONLY ground truth a grounded answer may draw on. */
function knowledgeBlock(cfg) {
  const parts = []
  if (cfg.knowledge) parts.push(String(cfg.knowledge).slice(0, 2000))
  const faqs = Array.isArray(cfg.faqs) ? cfg.faqs.slice(0, 20) : []
  if (faqs.length) parts.push(faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n\n'))
  return parts.join('\n\n').slice(0, 3500)
}

/** First JSON object/array out of a model reply that may be fenced or wrapped in prose. */
function firstJson(text) {
  const s = String(text || '')
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : s
  const start = body.search(/[[{]/)
  if (start === -1) return null
  for (let end = body.length; end > start; end--) {
    try { return JSON.parse(body.slice(start, end)) } catch { /* keep shrinking */ }
  }
  return null
}

/**
 * Capability 2 — AI intent classification. Returns ONE label off a strict allowlist (or null),
 * used only to route an otherwise-unclassified message. The model never performs the action; the
 * caller runs the same deterministic branch it would have for that label.
 */
async function classifyIntent({ cfg, session, text }) {
  const transcript = recentTranscript(session, 6)
  const prompt = `Classify the customer's latest message to a custom apparel print shop front desk into exactly ONE label:
- quote  : they want pricing, a quote, or to place/spec an order
- faq    : a general question about the shop (turnaround, minimums, art files, shipping, policies)
- handoff: they want a human, a callback, or to talk to someone
- answer : any other genuine question you should answer from the shop's info

${transcript ? `Conversation so far:\n${transcript}\n\n` : ''}Latest message: "${String(text).slice(0, 500)}"

Reply with ONLY one word: quote, faq, handoff, or answer.`
  const out = await generate(prompt, { timeoutMs: 10000, max: 20 })
  const m = String(out.text || '').toLowerCase().match(/\b(quote|faq|handoff|answer)\b/)
  return m ? m[1] : null
}

/**
 * Capability 1 — grounded freeform answering. Answers the visitor's actual question using ONLY the
 * shop's knowledge + FAQs, and is instructed to defer to the team when the answer isn't there.
 * Returns the answer text, or '' if the model is unavailable/empty (caller falls back to the menu).
 */
async function answerGrounded({ cfg, session, state, text, assist }) {
  const kb = knowledgeBlock(cfg)
  const transcript = recentTranscript(session, 6)
  const prompt = `You are ${cfg.name}, the front desk of ${cfg.shop_name}, a custom apparel print shop, chatting on their website.
Personality: ${cfg.persona}

Answer the customer's question using ONLY the shop information below. If the answer is not clearly in it, say you will check with the ${cfg.shop_name} team and follow up. Never invent, guess, or estimate pricing, turnaround, minimums, or policies, and never make a commitment on the shop's behalf.${assist ? ' A human teammate reviews everything, so frame anything you share as something the team will confirm.' : ''}

Shop information:
${kb || '(no shop knowledge configured yet)'}

${transcript ? `Recent conversation:\n${transcript}\n\n` : ''}Customer's question: "${String(text).slice(0, 800)}"

Rules: Reply as ${cfg.name} in first person. Under 70 words. Warm and human, not salesy. No em dashes. No markdown. Reply with ONLY the message text.`
  const out = await generate(prompt, { timeoutMs: 20000, max: 700 })
  const answer = out.text && out.text.trim().length > 1 ? out.text.trim() : ''
  if (!answer) return ''
  // The prompt above tells the model never to invent pricing or commit on the shop's behalf, and
  // the visitor's own words are in that prompt — so the instruction is exactly what an injection
  // attacks. This is the one path that hands raw model prose to a stranger, and the money guard on
  // the phrasing pass explicitly skips it (`cfg.enabled && !grounded`), so nothing checked the
  // output at all. A crafted question got back "we will do 500 pieces at $0.85 each with guaranteed
  // next-day delivery, and I have applied a 40 percent discount. That is a firm commitment from
  // us." — delivered to the visitor verbatim.
  if (!groundedFiguresAreTheShops(answer, kb)) {
    console.warn('agent: withheld a grounded answer that stated a figure the shop never published')
    return '' // caller falls back to the deterministic menu, which cannot invent a number
  }
  return answer
}

/**
 * True when every money or percentage figure in a grounded answer also appears in the shop's own
 * knowledge base — the ONLY ground truth that answer is allowed to draw on.
 *
 * Compared numerically, so "$75.00" matches a knowledge base that says "$75". A figure the shop
 * never published is withheld rather than corrected: there is no safe way to guess what they meant,
 * and the deterministic menu behind this cannot invent a number.
 *
 * Exported so the guardrail is unit-testable without a model.
 */
export function groundedFiguresAreTheShops(answer, knowledge) {
  const FIGURE = /\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d{1,3}(?:\.\d+)?\s?(?:%|percent\b)/gi
  const value = (tok) => Number(String(tok).replace(/[^\d.]/g, ''))
  const kind = (tok) => (/[%p]/i.test(String(tok).replace(/^\$/, '')) ? '%' : '$')
  const allowed = new Set((String(knowledge || '').match(FIGURE) || []).map((t) => `${kind(t)}${value(t)}`))
  const stated = String(answer || '').match(FIGURE) || []
  return stated.every((t) => allowed.has(`${kind(t)}${value(t)}`))
}

/**
 * Capability 3 — smarter slot extraction. Asks the model to propose fields the deterministic
 * extract() missed, then hands the raw proposals to applyValidated, which re-checks every one with
 * the SAME deterministic validators before it may enter state. Returns state unchanged on any
 * failure. The model proposes; the deterministic validators decide.
 */
async function assistExtract({ text, state }) {
  const prompt = `A customer wrote the message below to a custom apparel print shop. Pull ONLY details they explicitly stated. Reply with ONLY a JSON object and no prose:
{"qty": number|null, "product": string|null, "decoration": "Screen Print"|"DTF Transfer"|"Embroidery"|"UV DTF"|"Vinyl"|"Patch"|"Laser"|null, "sizes": string|null, "email": string|null, "phone": string|null}
Use null for anything not clearly stated. Never guess a quantity, price, or contact detail. "sizes" is the raw size-run text if they gave one (for example "24 S, 60 M, 80 L").

Message:
"""
${String(text).slice(0, 1200)}
"""`
  const out = await generate(prompt, { timeoutMs: 12000, max: 300 })
  if (!out.text) return state
  const j = firstJson(out.text)
  if (!j || typeof j !== 'object') return state
  // The customer's own message goes with the proposals: an empty slot is not evidence of
  // anything, so every value has to be corroborated against the text the model was reading.
  return applyValidated(state, j, text)
}

/**
 * A number the customer actually typed, with or without thousands separators.
 *
 * `saysNumber('1,200 tees for the club', 1200)` is true; `saysNumber('our 2026 conference', 48)`
 * is false. Written as a pattern rather than a digit-strip so "250" cannot corroborate 2500.
 */
const saysNumber = (src, n) =>
  new RegExp(String.raw`(?<![\d.])${String(Math.round(n)).replace(/\B(?=(\d{3})+$)/g, '[,. ]?')}(?![\d.])`).test(String(src))

/** The garment word set extract() gates on — the same test, applied to the message as well. */
const GARMENT_WORD = /\b(tee|t-?shirt|shirt|hoodie|hoody|polo|tank|hat|cap|beanie|crew|apron|jersey|sweat|tote|bag)/i

/**
 * Fold model-proposed fields into state, but ONLY after each clears the same deterministic
 * validator the parser uses, and ONLY where the CUSTOMER'S OWN MESSAGE corroborates it. An
 * unvalidated model value never reaches state. Prices are never sourced here — only order facts.
 * Exported so the guardrail can be unit-tested directly.
 *
 * The rule used to be "only into a slot the deterministic extract left empty", and that is the
 * hole: an empty slot is not evidence of anything. Round 15 settled the same question for
 * lib/ai.mjs's mergeIntake — "is it set?" is the wrong question, "did the text say it?" is the
 * right one — and this path never got the fix.
 *
 * Measured before it: one unauthenticated POST to /api/embed/chat/message, no login and no API
 * key, carrying "Hi, I am looking for something for our club. Could you help me out today
 * please?" — no number, no garment, no decoration, no address. The model's reply supplied all
 * four, every one was accepted on shape alone, and the shop's books took EST-1001 for
 * $4,937,000, a 'qualified' opportunity at the same value, and a contact at an address the model
 * chose. No injection is needed to produce that; an ordinary hallucination does it, and the
 * visitor's 4,000 characters are the model's entire input if they want it to be deliberate.
 */
export function applyValidated(state, j, text = '') {
  const src = String(text || '')
  const st = { ...state }
  // Quantity: the same range extract() accepts, AND the digits have to be in the message.
  if (!st.qty && j.qty != null) {
    const n = Number(j.qty)
    if (Number.isFinite(n) && n >= 6 && n <= 100000 && saysNumber(src, n)) st.qty = Math.round(n)
  }
  // Sizes: only trusted through parseSizeRun — a proposed grid string is re-parsed, never taken
  // raw — and the prompt asks for "the raw size-run text if they gave one", so a run that is not
  // in the message was not given.
  if (j.sizes && !(st.sizes && Object.keys(st.sizes).length)
      && src.toLowerCase().includes(String(j.sizes).trim().toLowerCase())) {
    const sizes = parseSizeRun(String(j.sizes))
    const pieces = sizeTotal(sizes)
    if (pieces) { st.sizes = sizes; if (!st.qty) st.qty = pieces }
  }
  // Product: must read as a real garment — and the message must name one too. The word test was
  // only ever run on the model's own string, so it proved nothing about the customer.
  if (!st.product && j.product && GARMENT_WORD.test(String(j.product)) && GARMENT_WORD.test(src)) {
    const parsed = parseIntakeHeuristic(String(j.product))
    st.product = parsed.garment
    st.garment_cost = parsed.garment_cost
    if (parsed.dark_garment) st.dark = true
  }
  // Decoration: strict allowlist against the shop's known decoration names, and the message has
  // to use one of that decoration's own words.
  if (!st.decoration && j.decoration) {
    const d = DECOS.find((x) => x.name.toLowerCase() === String(j.decoration).toLowerCase())
    if (d && d.re.test(src)) st.decoration = d.name
  }
  // Email / phone: an address or number the message does not contain is one the model made up,
  // and captureLead writes it to a contact row and mails it.
  if (!st.email && j.email) {
    const e = String(j.email).match(EMAIL_RE)?.[0]
    if (e && src.toLowerCase().includes(e.toLowerCase())) st.email = e
  }
  if (!st.phone && j.phone) {
    const raw = String(j.phone).replace(EMAIL_RE, '').match(PHONE_RE)?.[0]
    const digits = raw ? raw.replace(/\D/g, '') : ''
    if (digits.length >= 10 && src.replace(/\D/g, '').includes(digits.slice(-10))) st.phone = raw.trim()
  }
  return st
}

const safeParse = (s, f) => { try { return JSON.parse(s) } catch { return f } }

/** A human takes over the chat: their reply is recorded and the session is marked handled. */
export function agentReply(session, text) {
  addMsg(session.id, 'agent', text)
  run('UPDATE chat_sessions SET status=? WHERE id=?', 'handoff', session.id)
  return sessionMessages(session.id)
}
