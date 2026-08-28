#!/usr/bin/env node
/**
 * Offline administration, run on the server by whoever owns the box.
 *
 *   node bin/admin.mjs list-shops
 *   node bin/admin.mjs list-users <shop-slug>
 *   node bin/admin.mjs reset-password <email> [new-password]
 *   node bin/admin.mjs promote <email>
 *
 * This exists because password reset goes out by email, and a fresh self-hosted install has no
 * email configured. Without an offline path, an owner who forgets their password on day two is
 * locked out of their own shop permanently, with their data sitting right there on the disk.
 *
 * Anyone who can run this already has filesystem access to every shop's database, so it grants no
 * privilege they didn't have. It just makes recovery a command instead of a SQLite session.
 *
 * Point PSC_DB at the same path the server uses, or run it from the app directory with the same
 * .env the service uses:
 *   PSC_DB=/var/lib/printshopcrm/printshop.db node bin/admin.mjs list-shops
 */
import { randomBytes } from 'node:crypto'

process.env.PSC_AUTH = '1' // the control-plane tables only exist in multi-tenant mode

const [cmd, ...args] = process.argv.slice(2)

const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1) }
const ok = (msg) => console.log(`  ${msg}`)

function usage() {
  console.log(`
  PrintShopCRM admin

    node bin/admin.mjs list-shops
        Every shop in this install, with its owner.

    node bin/admin.mjs list-users <shop-slug>
        Everyone who can sign in to that shop, and their role.

    node bin/admin.mjs reset-password <email> [new-password]
        Set a password directly, no email needed. Generates a strong one if you omit it.
        This is the way out of a lockout.

    node bin/admin.mjs promote <email>
        Make an existing member an owner. For when the only owner has left.

  Database: ${process.env.PSC_DB || '(default: ./data/printshop.db)'}
  Set PSC_DB to the path your server uses, or run with the service's .env.
`)
}

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); process.exit(0) }

// Imported after PSC_AUTH is set — the module opens the control database on import.
const T = await import('../lib/tenants.mjs')

/** A password that satisfies any sane policy and is safe to read over the phone. */
const strongPassword = () => `psc-${randomBytes(9).toString('base64url')}`

switch (cmd) {
  case 'list-shops': {
    const slugs = T.activeTenantSlugs()
    if (!slugs.length) die('No shops yet. Someone needs to sign up first.')
    console.log()
    for (const slug of slugs) {
      const t = T.getTenantBySlug(slug)
      if (!t) continue
      const members = T.listMembers(t.id)
      const owner = members.find((m) => m.role === 'owner')
      ok(`${slug.padEnd(24)} ${String(t.shop_name || '').padEnd(28)} ${owner?.email || '(no owner!)'}  [${members.length} user${members.length === 1 ? '' : 's'}]`)
    }
    console.log()
    break
  }

  case 'list-users': {
    const slug = args[0] || die('Which shop? Run list-shops to see the slugs.')
    const t = T.getTenantBySlug(slug) || die(`No shop with slug "${slug}".`)
    const members = T.listMembers(t.id)
    if (!members.length) die(`"${slug}" has no members — this shop cannot be signed in to. Use reset-password to recreate the owner.`)
    console.log()
    for (const m of members) ok(`${String(m.email).padEnd(34)} ${String(m.role).padEnd(9)} ${m.status || 'active'}`)
    console.log()
    break
  }

  case 'reset-password': {
    const email = (args[0] || '').trim().toLowerCase() || die('Which email? e.g. node bin/admin.mjs reset-password owner@shop.com')
    const member = T.getMemberByEmail(email)
    if (!member) {
      const shops = T.activeTenantSlugs().length
      die(`No account for "${email}".${shops ? ' Run list-shops, then list-users <slug> to see the real addresses.' : ' There are no shops in this database — check PSC_DB points where you think it does.'}`)
    }
    const password = args[1] || strongPassword()
    if (password.length < T.MIN_PASSWORD) die(`Password must be at least ${T.MIN_PASSWORD} characters.`)

    await T.setMemberPassword(member.id, password)
    // Owners historically also carried a password on the tenant row; keep the two in step so an
    // older login path can't still accept the previous password.
    if (member.role === 'owner') await T.setPassword(member.tenant_id, password)

    const shop = T.getTenantById(member.tenant_id)
    console.log()
    ok(`Password set for ${email} (${shop?.shop_name || 'unknown shop'}, role ${member.role})`)
    ok('')
    ok(`    ${password}`)
    ok('')
    ok(args[1] ? 'Sign in with the password you supplied.' : 'Copy it now — it is not stored anywhere in readable form.')
    // setMemberPassword deletes every session for this member — deliberately, so a compromised
    // one dies with the password. This line used to claim the opposite.
    ok('Every existing session for this account has been signed out.')
    console.log()
    break
  }

  case 'promote': {
    const email = (args[0] || '').trim().toLowerCase() || die('Which email?')
    const member = T.getMemberByEmail(email) || die(`No account for "${email}".`)
    if (member.role === 'owner') die(`${email} is already an owner.`)
    T.updateMember(member.tenant_id, member.id, { role: 'owner' })
    console.log()
    ok(`${email} is now an owner of ${T.getTenantById(member.tenant_id)?.shop_name || 'the shop'}.`)
    console.log()
    break
  }

  default:
    console.error(`\n  Unknown command "${cmd}".`)
    usage()
    process.exit(1)
}

process.exit(0)
