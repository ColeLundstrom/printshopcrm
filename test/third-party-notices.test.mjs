import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'

const read = (path) => readFileSync(new URL('../' + path, import.meta.url))
const json = (path) => JSON.parse(read(path))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const gitBlob = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const inventory = () => json('docs/third-party/dependency-inventory.json')
const provenance = () => json('docs/third-party/nodable-notice-verification.json')
const supplementPath = 'third-party/nodable-entities/LICENSE'
const sourceCommit = 'ac48e7ea591da372be023a481875c747535812b3'
const declarationCommit = 'd2070d76a8ba07e6c7fa142caeb51ffd756e47eb'
const licenseHash = '750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40'

function section(notices, entry) {
  const start = `<!-- BEGIN NOTICE: ${entry.path} -->\n`
  const end = `<!-- END NOTICE: ${entry.path} -->`
  assert.equal(notices.split(start).length, 2, `One notice section required for ${entry.path}`)
  assert.equal(notices.split(end).length, 2, `One notice section end required for ${entry.path}`)
  const text = notices.slice(notices.indexOf(start) + start.length, notices.indexOf(end))
  assert.ok(text.startsWith(`## ${entry.name} ${entry.version}\n`), `Misattributed notice for ${entry.path}`)
  return text
}

test('notice inventory covers every locked package path, name, version and integrity', () => {
  const lock = json('package-lock.json')
  const audit = inventory()
  const paths = Object.keys(lock.packages).filter(Boolean).sort()
  assert.deepEqual(audit.entries.map((entry) => entry.path).sort(), paths,
    'Review and update third-party notices whenever the lockfile changes')
  assert.equal(audit.lockfile_sha256, sha256(read('package-lock.json')))
  for (const entry of audit.entries) {
    const locked = lock.packages[entry.path]
    const installed = json(`${entry.path}/package.json`)
    assert.equal(entry.name, entry.path.split('node_modules/').at(-1), entry.path)
    assert.equal(entry.name, installed.name, entry.path)
    assert.equal(entry.version, locked.version, entry.path)
    assert.equal(entry.version, installed.version, entry.path)
    assert.ok(locked.integrity, `Missing lockfile integrity for ${entry.path}`)
    assert.equal(entry.integrity, locked.integrity, entry.path)
    assert.equal(entry.declared_license, locked.license ?? null, entry.path)
  }
})

test('each dependency notice retains the complete installed license text under its attribution', () => {
  const notices = read('THIRD_PARTY_NOTICES.md').toString('utf8')
  const entries = inventory().entries
  assert.equal((notices.match(/<!-- BEGIN NOTICE: /g) || []).length, entries.length)
  for (const entry of entries) {
    const text = section(notices, entry)
    assert.match(text, new RegExp(`Declared/reviewed license: ${entry.reviewed_license}\\n`))
    const supplied = entry.supplemental_license_files || []
    assert.ok(entry.license_files.length + supplied.length > 0, `No notice text for ${entry.path}`)
    for (const license of entry.license_files) {
      const bytes = read(`${entry.path}/${license}`)
      assert.ok(bytes.length > 0, `Empty license for ${entry.path}`)
      // The repository enforces LF checkouts; only line endings may differ from npm's files.
      assert.ok(text.includes(bytes.toString('utf8').replaceAll('\r\n', '\n')), `Incomplete ${entry.path}/${license}`)
    }
    for (const license of supplied) {
      assert.ok(Buffer.from(text).includes(read(license)), `Incomplete supplemental ${license}`)
    }
  }
})

test('the missing npm notice is shipped unchanged from its pinned upstream license', () => {
  const source = provenance()
  const bytes = read(supplementPath)
  assert.equal(sha256(bytes), licenseHash)
  assert.equal(source.license_sha256, licenseHash)
  assert.equal(source.license_file, supplementPath)
  assert.equal(source.upstream_commit, sourceCommit)
  assert.equal(source.upstream_license, `https://github.com/nodable/val-parsers/blob/${sourceCommit}/LICENSE`)
  assert.equal(gitBlob(bytes), source.upstream_license_git_blob_sha)
  assert.equal(source.upstream_license_git_blob_sha, '561468f111a66df52cc0f1934642bb9fdd22a212')
  const entry = inventory().entries.find((item) => item.name === '@nodable/entities')
  assert.equal(entry.version, '3.0.0')
  assert.deepEqual(entry.license_files, [])
  assert.deepEqual(entry.supplemental_license_files, [supplementPath])
})

test('all shipped nodable package files retain their recorded upstream source matches', () => {
  const source = provenance()
  const base = 'node_modules/@nodable/entities'
  const listFiles = (prefix = '') => readdirSync(new URL(`../${base}/${prefix}`, import.meta.url), { withFileTypes: true })
    .flatMap((file) => file.isDirectory() ? listFiles(`${prefix}${file.name}/`) : [`${prefix}${file.name}`])
  const installedFiles = listFiles().sort()
  assert.deepEqual(source.checked_files.map((file) => file.path).sort(), installedFiles)
  for (const file of source.checked_files) {
    const actual = gitBlob(read(`${base}/${file.path}`))
    assert.equal(actual, file.installed_git_blob_sha, file.path)
    if (file.path === 'src/index.d.ts') {
      assert.equal(file.matches, false, 'Do not hide the declaration mismatch at the primary source commit')
      assert.notEqual(actual, file.upstream_git_blob_sha)
      assert.equal(file.alternate_source.commit, declarationCommit)
      assert.equal(file.alternate_source.path, 'Entity/src/index.d.ts')
      assert.equal(actual, file.alternate_source.git_blob_sha)
      assert.equal(file.alternate_source.license_git_blob_sha, source.upstream_license_git_blob_sha)
    } else {
      assert.equal(file.matches, true, file.path)
      assert.equal(actual, file.upstream_git_blob_sha, file.path)
    }
  }
  assert.equal(source.all_installed_files_match_single_snapshot, false)
  assert.equal(source.all_installed_files_traced, true)
})
