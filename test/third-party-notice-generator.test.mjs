import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectNotices } from '../bin/update-third-party-notices.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const options = { reviewedAt: '2026-10-10', sourceCommit: '0000000000000000000000000000000000000000' }

function fixture(t, license) {
  const dir = mkdtempSync(join(tmpdir(), 'psc-notice-generator-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const write = (path, value) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value))
  }
  write('package-lock.json', { packages: { '': {}, 'node_modules/example': { version: '1.0.0', license: 'MIT', integrity: 'sha512-fixture-only' } } })
  write('node_modules/example/package.json', { name: 'example', version: '1.0.0' })
  write('docs/third-party/dependency-inventory.json', { source_commit: options.sourceCommit, scope: 'Synthetic test only', entries: [] })
  write('docs/third-party/nodable-notice-verification.json', {})
  write('THIRD_PARTY_NOTICES.md', '')
  if (license !== undefined) write('node_modules/example/LICENSE', license)
  return { dir, write }
}

test('notice generation is deterministic and does not change its inputs', () => {
  const before = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'))
  const first = collectNotices(root, options)
  assert.deepEqual(collectNotices(root, options), first)
  assert.deepEqual(readFileSync(join(root, 'THIRD_PARTY_NOTICES.md')), before)
  assert.ok(first.notices.includes('<!-- BEGIN NOTICE: node_modules/@nodable/entities -->'))
})

test('a dependency without packaged or specifically verified supplemental text stops generation', (t) => {
  const { dir } = fixture(t)
  assert.throws(() => collectNotices(dir, options), /no packaged notice; verify a pinned supplemental source/)
})

test('generation keeps complete license wording and additional notice files with only LF normalization', (t) => {
  const text = 'Copyright Example Authors  \r\nPermission text.\r\nDisclaimer text.\r\n'
  const { dir, write } = fixture(t, text)
  write('node_modules/example/NOTICE.txt', 'Additional attribution.\n')
  const output = collectNotices(dir, options)
  assert.ok(output.notices.includes(text.replaceAll('\r\n', '\n')))
  assert.ok(output.notices.includes('Additional attribution.\n'))
  assert.deepEqual(JSON.parse(output.inventory).entries[0].license_files, ['LICENSE', 'NOTICE.txt'])
})

test('generation rejects an installed version that differs from the locked package', (t) => {
  const { dir, write } = fixture(t, 'Example notice.\n')
  write('node_modules/example/package.json', { name: 'example', version: '2.0.0' })
  assert.throws(() => collectNotices(dir, options), /needs npm ci/)
})
