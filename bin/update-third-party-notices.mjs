#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const inventoryPath = 'docs/third-party/dependency-inventory.json'
const provenancePath = 'docs/third-party/nodable-notice-verification.json'
const noticesPath = 'THIRD_PARTY_NOTICES.md'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const gitBlob = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const normalize = (text) => text.replaceAll('\r\n', '\n')

// This collects reviewed inputs; it does not infer missing rights or fetch a newer license.
export function collectNotices(root, { reviewedAt, sourceCommit }) {
  assert.match(reviewedAt, /^\d{4}-\d{2}-\d{2}$/, 'Supply --reviewed-at YYYY-MM-DD')
  assert.match(sourceCommit, /^[a-f0-9]{40}$/, 'Supply the full --source-commit reviewed checkout')
  const read = (path) => readFileSync(resolve(root, path))
  const json = (path) => JSON.parse(read(path))
  const lockBytes = read('package-lock.json')
  const lock = JSON.parse(lockBytes)
  const previous = json(inventoryPath)
  const priorEntries = new Map(previous.entries.map((entry) => [entry.path, entry]))
  const source = json(provenancePath)
  const oldNotices = normalize(read(noticesPath).toString('utf8'))
  const sections = []
  const entries = []

  for (const path of Object.keys(lock.packages).filter(Boolean).sort()) {
    assert.match(path, /^(?:node_modules\/)(?:[^.][^/]*\/)*[^/]+$/, `Unsupported package path ${path}`)
    assert.ok(!path.split('/').includes('..'), `Unsafe package path ${path}`)
    const locked = lock.packages[path]
    const installed = json(`${path}/package.json`)
    const name = path.split('node_modules/').at(-1)
    assert.equal(installed.name, name, `${path} name differs from the lockfile path`)
    assert.equal(installed.version, locked.version, `${path} needs npm ci`)
    assert.ok(locked.integrity, `${path} needs a locked integrity`)
    const prior = priorEntries.get(path)
    const unchanged = prior?.name === name && prior.version === locked.version && prior.integrity === locked.integrity
    const declared = locked.license ?? null
    const reviewed = declared || (unchanged && prior.reviewed_license)
    assert.ok(typeof reviewed === 'string' && reviewed.length, `${path} requires manual license review`)
    const files = readdirSync(resolve(root, path), { withFileTypes: true })
      .filter((file) => file.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(file.name))
      .map((file) => file.name).sort()
    const entry = {
      path, name, version: locked.version,
      declared_license: declared,
      reviewed_license: reviewed,
      license_files: files,
      integrity: locked.integrity
    }
    let section = `## ${name} ${locked.version}\n\nDeclared/reviewed license: ${reviewed}\n\n`
    if (files.length) {
      for (const file of files) {
        const text = normalize(read(`${path}/${file}`).toString('utf8'))
        assert.ok(text.trim(), `${path}/${file} is empty`)
        section += `### ${file}\n\n${text}\n\n`
      }
    } else {
      assert.ok(unchanged && name === '@nodable/entities' && prior.supplemental_license_files?.length === 1,
        `${path} has no packaged notice; verify a pinned supplemental source before updating`)
      const supplement = prior.supplemental_license_files[0]
      assert.equal(supplement, source.license_file)
      assert.equal(hash(read(supplement)), source.license_sha256, 'Supplemental license changed')
      const installedFiles = (prefix = '') => readdirSync(resolve(root, path, prefix), { withFileTypes: true })
        .flatMap((file) => file.isDirectory() ? installedFiles(`${prefix}${file.name}/`) : [`${prefix}${file.name}`])
      assert.deepEqual(installedFiles().sort(), source.checked_files.map((file) => file.path).sort())
      for (const file of source.checked_files) {
        assert.equal(gitBlob(read(`${path}/${file.path}`)), file.installed_git_blob_sha,
          `${path}/${file.path} differs from the reviewed supplemental provenance`)
      }
      const begin = `<!-- BEGIN NOTICE: ${path} -->\n`
      const end = `<!-- END NOTICE: ${path} -->`
      assert.equal(oldNotices.split(begin).length, 2, 'Missing or duplicate supplemental notice section')
      assert.equal(oldNotices.split(end).length, 2, 'Missing or duplicate supplemental notice section end')
      const start = oldNotices.indexOf(begin) + begin.length
      assert.ok(oldNotices.indexOf(end) > start, 'Invalid supplemental section order')
      section = oldNotices.slice(start, oldNotices.indexOf(end))
      assert.ok(section.startsWith(`## ${name} ${locked.version}\n`))
      assert.ok(Buffer.from(section).includes(read(supplement)), 'Supplemental section must retain the complete license')
      entry.notice_status = prior.notice_status
      entry.notice_evidence = prior.notice_evidence
      entry.supplemental_license_files = prior.supplemental_license_files
    }
    entries.push(entry)
    sections.push(`<!-- BEGIN NOTICE: ${path} -->\n${section}<!-- END NOTICE: ${path} -->\n\n`)
  }
  const packaged = entries.filter((entry) => entry.license_files.length).length
  const supplemented = entries.filter((entry) => entry.supplemental_license_files?.length).length
  const header = `# Third-party npm notices\n\nReviewed ${reviewedAt} against the locked npm dependencies. This file preserves the\nfull packaged license texts for ${packaged} dependency entries and the source-attributed\nsupplemental notices for ${supplemented} dependency entries, covering all ${entries.length} lockfile\nentries. Duplicate package versions installed at different paths retain their\nown attribution sections. License wording and author/copyright notices are\npreserved; CRLF line endings are normalized to LF to match this repository.\n\nThese notices do not change the application's [LICENSE](LICENSE), establish\nindependent authorship, or provide legal, ownership, asset-rights or security\nclearance. They cover the locked npm dependencies only, not the Node/Alpine\ncontainer base, operating-system packages, browser tooling, images, fonts or\nother non-npm assets. Preserve those components' own notices as applicable.\n\nSee the [inventory and maintenance guide](docs/third-party/README.md) for\nprovenance, scope and offline verification.\n\n`
  const inventory = {
    reviewed_at: reviewedAt,
    source_commit: previous.source_commit,
    scope: previous.scope,
    entries,
    packaging_verified_commit: sourceCommit,
    lockfile_sha256: hash(lockBytes)
  }
  return { notices: header + sections.join(''), inventory: JSON.stringify(inventory, null, 2) + '\n' }
}

export function main(args = process.argv.slice(2)) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    assert.ok(['--reviewed-at', '--source-commit'].includes(name), `Unknown option ${name}`)
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value for ${name}`)
    assert.ok(!Object.hasOwn(options, name), `Duplicate option ${name}`)
    options[name] = args[index + 1]
  }
  const root = fileURLToPath(new URL('../', import.meta.url))
  const result = collectNotices(root, {
    reviewedAt: options['--reviewed-at'], sourceCommit: options['--source-commit']
  })
  // Validate every input before replacing either artifact.
  writeFileSync(resolve(root, noticesPath), result.notices)
  writeFileSync(resolve(root, inventoryPath), result.inventory)
  console.log(`Updated ${noticesPath} and ${inventoryPath}; review the diff and run the notice tests.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
