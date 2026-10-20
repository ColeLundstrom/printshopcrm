import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')

// A deleted shop's slug goes to the next signup with the same name. The learned public origin used
// to be stored under that slug, so a Host header taught by the old owner became the address in the
// new owner's password-reset email. It must be keyed by the never-reused tenant id.
test('learned public origins are keyed by tenant id, never by a reusable slug', () => {
  const block = src.slice(src.indexOf('let learnedOrigins = null'), src.indexOf('const slackRaw = express.raw('))
  assert.match(block, /setPlatformConfig\(\{ \[`origin:t\$\{id\}`\]: o \}\)/)
  assert.doesNotMatch(block, /origin:\$\{slug\}/)
  assert.match(block, /\^origin:t\\d\+\$/, 'legacy slug-keyed rows are not read back')
  assert.doesNotMatch(src, /learnedOriginFor\([^)]*\.slug\)/, 'every caller passes the tenant, not its slug')
})

// The onboarding row lives in the control db that every shop shares; a staff member could replace
// it with a 900 KB body.
test('saving onboarding answers is owner-only and shape-limited', () => {
  const at = src.indexOf("app.post('/api/auth/onboarding'")
  const route = src.slice(at, src.indexOf('}))', at))
  assert.match(route, /requireRole\('owner'\)/)
  assert.match(route, /slice\(0, 40\)/)
  assert.match(route, /status\(413\)/)
})
