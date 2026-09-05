/**
 * AI-assisted onboarding.
 *
 * A new shop owner describes their shop in plain English ("4-person screen print + embroidery
 * shop, one auto and one manual press, we charge about $65/hr, DTF on a 22 inch roll at a dollar
 * an inch, 8.25% tax"). This deterministic parser reads that into concrete settings so the shop
 * is configured from a single sentence — then every value is shown and editable in Settings.
 *
 * Deterministic on purpose: it works with no model and never guesses silently — it only sets a
 * value it actually found, and reports exactly what it changed.
 */
import { shopFormat } from './db.mjs'

const METHODS = [
  [/screen[\s-]?print|screenprint|silk\s?screen/i, 'Screen printing'],
  [/embroider/i, 'Embroidery'],
  [/\bdtf\b|direct[\s-]?to[\s-]?film/i, 'DTF transfers'],
  [/heat[\s-]?press|htv|vinyl/i, 'Heat press / vinyl'],
  [/sublimat/i, 'Sublimation'],
  [/\buv\s?dtf\b/i, 'UV DTF'],
  [/sign|banner|wide[\s-]?format/i, 'Signs & banners'],
  [/promo|promotional/i, 'Promotional products'],
  [/laser|engrav/i, 'Laser / engraving'],
]

const num = (m) => (m ? Number(m[1]) : null)

/**
 * Parse a free-text shop description into settings. Returns { settings, applied[], methods[] }
 * where `applied` is a human-readable list of what was set (for the confirmation screen).
 */
export function parseShopProfile(text) {
  const t = String(text || '')
  const settings = {}
  const applied = []
  const set = (key, value, label) => { settings[key] = String(value); applied.push(label) }

  // Shop hourly rate: "$65/hr", "65 per hour", "charge 70 an hour"
  const rate = num(t.match(/\$?\s*(\d{2,3})\s*(?:\/|per\s*|an?\s*)?\s*(?:hr|hour)\b/i))
  if (rate && rate >= 20 && rate <= 500) set('shop_hourly_rate', rate, `Shop rate set to ${shopFormat().moneyShort(rate)}/hr`)

  // DTF price per inch: "$1/inch", "a dollar an inch", "0.95 per inch"
  const perInch = num(t.match(/\$?\s*([\d.]+)\s*(?:\/|per\s*|an?\s*)?\s*(?:inch|in)\b/i))
  if (perInch && perInch > 0 && perInch < 20) set('dtf_price_per_inch', perInch, `DTF price set to ${shopFormat().moneyShort(perInch)}/inch`)
  else if (/\bdollar\s+(?:an?|per)\s+inch\b/i.test(t)) set('dtf_price_per_inch', 1, `DTF price set to ${shopFormat().moneyShort(1)}/inch`)

  // DTF roll width: "22 inch roll", "24\" roll"
  const roll = num(t.match(/(\d{2})\s*(?:"|inch|in)\s*(?:wide\s*)?roll/i)) || num(t.match(/roll\s*(?:is|of)?\s*(\d{2})\s*(?:"|inch|in)/i))
  if (roll && roll >= 10 && roll <= 64) set('dtf_sheet_width', roll, `DTF roll width set to ${roll}"`)

  // Sales tax: "8.25% tax", "tax is 7.75"
  const tax = num(t.match(/([\d.]+)\s*%\s*(?:sales\s*)?tax/i)) || num(t.match(/tax\s*(?:is|rate|of)?\s*:?\s*([\d.]+)\s*%?/i))
  if (tax !== null && tax >= 0 && tax <= 15) set('tax_rate', tax, `Sales tax set to ${tax}%`)

  // Target margin: "45% margin", "aim for 50% markup"
  const margin = num(t.match(/([\d]{2})\s*%\s*(?:target\s*)?(?:margin|markup)/i))
  if (margin && margin >= 15 && margin <= 90) set('target_margin_pct', margin, `Target margin set to ${margin}%`)

  // Press type
  if (/manual\s*(?:press\s*)?only|only\s*(?:a\s*)?manual/i.test(t)) set('press_type', 'manual', 'Default press set to manual')
  else if (/\bauto(?:matic)?\s*press\b|auto\b/i.test(t)) set('press_type', 'auto', 'Default press set to automatic')

  // Decoration methods detected (stored as a note; drives which parts of the tour to emphasize)
  const methods = METHODS.filter(([re]) => re.test(t)).map(([, name]) => name)

  return { settings, applied, methods }
}

/** The setup checklist shown on the welcome screen — each item deep-links to where it's done. */
export function onboardingChecklist(settings) {
  const has = (k) => settings[k] && String(settings[k]).trim().length > 0
  return [
    { key: 'describe', title: 'Tell us about your shop', done: false, hint: 'One sentence configures your pricing.' },
    { key: 'pricing', title: 'Confirm your costing numbers', href: '#/settings', done: has('shop_hourly_rate'), hint: 'Rate, utilization, spoilage, target margin.' },
    { key: 'stripe', title: 'Connect your Stripe (optional)', href: '#/settings', done: /^sk_(test|live)_/.test(settings.stripe_secret || ''), hint: 'Take deposits and gang-sheet payments on your own account.' },
    { key: 'gangsheet', title: 'Add the gang-sheet builder to your website', href: '#/settings', done: false, hint: 'Copy one iframe snippet.' },
    { key: 'suppliers', title: 'Connect S&S / SanMar (optional)', href: '#/settings', done: has('ss_api_key') || has('sanmar_user'), hint: 'Live blank costs feed your job margins.' },
    { key: 'slack', title: 'Quote from Slack (optional)', href: '#/settings', done: has('slack_bot_token') && has('slack_signing_secret'), hint: 'Paste a customer message in Slack, get a draft estimate back. Setup is one copy-paste.' },
    { key: 'customer', title: 'Add your first customer', href: '#/contacts?new=1', done: false, hint: 'Or import later — nothing is locked in.' },
  ]
}

/**
 * The guided-setup steps for the onboarding wizard, each with a live "done" state. A step is done
 * when it's been explicitly completed in the wizard OR its real signal is already satisfied (a key
 * connected, customers imported) — so setting something up directly in Settings also ticks it off,
 * and "finish later" is always accurate. Every step is optional; only `basics` is recommended.
 */
export function onboardingSteps(settings, ctx = {}) {
  const progress = (() => { try { return JSON.parse(settings.onboarding_progress || '{}') } catch { return {} } })()
  const marked = (k) => progress[k] === 'done'
  const touched = (k) => progress[k] === 'done' || progress[k] === 'skipped'
  const has = (k) => settings[k] && String(settings[k]).trim().length > 0
  const defs = [
    // Basics is the one step the seed can fake: a new shop already has its name (from signup) and the
    // default hourly rate, so a derived signal marked it done before the owner had seen it — and the
    // wizard then resumed past the welcome/describe screen entirely. Only an explicit completion counts.
    { key: 'quote', icon: 'estimates', title: 'Price a real request', hint: 'Paste what a customer sent and get a priced estimate back. No setup needed.',
      done: marked('quote') },
    { key: 'basics', icon: 'settings', title: 'Shop & costing basics', hint: 'Name, hourly rate, and the numbers that make quoting tell you real margin.', required: true,
      done: marked('basics') },
    { key: 'pricing', icon: 'pricing', title: 'Pricing rules & blank markup', hint: 'Your markup on blanks, screen fee, per-service pricing, size upcharges.',
      done: marked('pricing') },
    // Google Drive holds the shop's artwork in an account they own. Done the moment the server
    // confirms the OAuth connection (settings.gdrive_connected) — no wizard click required.
    { key: 'drive', icon: 'art', title: 'Connect Google Drive', hint: 'Store artwork in your own Google Drive so you keep control and storage is never capped.',
      done: !!settings.gdrive_connected || marked('drive'), skipped: !settings.gdrive_connected && progress.drive === 'skipped' },
    { key: 'ai', icon: 'receptionist', title: 'Turn on AI (your own key)', hint: 'Bring your Anthropic or OpenAI key so the receptionist and quoting run on your account.',
      done: !!ctx.aiOn || has('ai_api_key') || marked('ai'), skipped: !ctx.aiOn && !has('ai_api_key') && progress.ai === 'skipped' },
    // Email done when their own outbound is configured (smtp_host present). This is the one that
    // silently loses messages if skipped — replies just sit in the Outbox and never send.
    { key: 'email', icon: 'outbox', title: 'Connect email so you can send', hint: 'Estimates, proofs and replies email from your own address. Without it messages only save to the Outbox.',
      done: has('smtp_host') || marked('email'), skipped: !has('smtp_host') && progress.email === 'skipped' },
    { key: 'sms', icon: 'conversations', title: 'Connect SMS for texting', hint: 'Two-way texting with customers needs your own Twilio number. Optional, but conversations stay silent without it.',
      done: has('twilio_sid') || marked('sms'), skipped: !has('twilio_sid') && progress.sms === 'skipped' },
    { key: 'payments', icon: 'billing', title: 'Collect payments', hint: 'Stripe or Authorize.net — take deposits and payments into your account.',
      done: !!ctx.stripeOn || marked('payments'), skipped: !ctx.stripeOn && progress.payments === 'skipped' },
    { key: 'distributors', icon: 'products', title: 'Distributor accounts', hint: 'S&S / SanMar / AlphaBroder — live blank costs, accurate quotes, and one-click purchase orders.',
      done: !!ctx.suppliersOn || marked('distributors'), skipped: !ctx.suppliersOn && progress.distributors === 'skipped' },
    // Import counts only when the owner actually imported — the demo quote seeds a sample contact,
    // so a customers>0 check falsely showed "your customers are in" before any import happened.
    { key: 'import', icon: 'customers', title: 'Bring your customers over', hint: 'Import your customer list from your old tool with a CSV.',
      done: marked('import'), skipped: progress.import === 'skipped' },
  ]
  // Skipping is not doing: only real completions count toward the number the owner sees.
  const doneCount = defs.filter((d) => d.done).length
  return { steps: defs, done: doneCount, total: defs.length, pct: Math.round((doneCount / defs.length) * 100) }
}

/** The recognized decoration services, with sensible default multipliers relative to screen print. */
export const SERVICE_DEFAULTS = { 'Screen Print': 1, 'DTF Transfer': 1.1, 'UV DTF': 1.15, Embroidery: 1.45, Vinyl: 1.2, Patch: 1.3, Laser: 1.25 }
