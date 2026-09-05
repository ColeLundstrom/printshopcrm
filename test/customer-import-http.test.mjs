import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { DatabaseSync } from 'node:sqlite'

test('customer import reports committed rows through COMMIT and activity failures, then resumes safely', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-contact-http-')), dest = join(temp, 'demo')
  const server = await createHttpTestServer(), { port, base } = server
  let db
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const slug = readdirSync(join(dest, 'data/tenants'))[0]
    db = new DatabaseSync(join(dest, 'data/tenants', slug, 'printshop.db'))
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE import_test_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE import_test_child(parent_id INTEGER REFERENCES import_test_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER import_test_commit AFTER INSERT ON contacts WHEN NEW.email='import501@example.test'
      BEGIN INSERT INTO import_test_child(parent_id) VALUES(999); END;
      CREATE TRIGGER import_test_activity BEFORE INSERT ON activities WHEN NEW.description LIKE 'Imported %customer%from CSV%'
      BEGIN SELECT RAISE(ABORT, 'fixture activity unavailable'); END;`)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')); env.PSC_TICK_MS = '3600000'
    let log = ''
    await server.start({ cwd: dest, env,
      args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'], onOutput: text => { log += text } })
    assert.match(log, /ws \/ws live/)
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const text = 'Name,Email\n' + Array.from({ length: 600 }, (_, i) => `Imported Customer ${i + 1},import${i + 1}@example.test`).join('\n')
    const submit = () => fetch(base + '/api/import/contacts', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    const stored = () => db.prepare("SELECT COUNT(*) n FROM contacts WHERE email LIKE 'import%@example.test'").get().n
    let response = await submit(), body = await response.json()
    assert.equal(stored(), 500, 'the first batch committed and the second rolled back at COMMIT')
    assert.equal(response.status, 503, JSON.stringify(body))
    assert.equal(body.imported, 500, 'HTTP must report durable customers, not attempted INSERTs')
    assert.equal(body.of, 600)
    assert.equal(body.code, 'import_interrupted')
    assert.match(body.error, /500/)
    assert.doesNotMatch(body.error, /nothing was saved|Nothing was written|Something went wrong/)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM import_test_child').get().n, 0, 'failed batch rolled back trigger writes too')

    db.exec('DROP TRIGGER import_test_commit')
    response = await submit(); body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.created, 100, 'activity failure cannot hide a successful resume')
    assert.equal(body.duplicates, 500)
    assert.equal(stored(), 600)
    response = await submit(); body = await response.json()
    assert.equal(response.status, 200); assert.equal(body.created, 0); assert.equal(body.duplicates, 600)
    assert.equal(stored(), 600)
    assert.equal((await fetch(base + '/health')).status, 200, 'no transaction remains open after recovery')
  } finally {
    db?.close()
    await server.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
