import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')

test('upgrade and recovery instructions use the same complete backup directory', () => {
  const guide = readFileSync(join(repo, 'INSTALL.md'), 'utf8')
  const upgrade = guide.split('## Upgrading\n')[1].split('### Confirming the server runs')[0]
  assert.match(upgrade, /BACKUP_DIR="\/var\/lib\/printshopcrm\/backups\/pre-upgrade-/)
  assert.match(upgrade, /npm run snapshot -- \/var\/lib\/printshopcrm "\$BACKUP_DIR"/)
  assert.match(upgrade, /tar czhf "\$BACKUP_DIR\/uploads\.tar\.gz"/)
  assert.match(upgrade, /sudo -u printshopcrm git pull --ff-only/)
  assert.match(upgrade, /sudo -u printshopcrm npm ci --omit=dev/)
  assert.match(upgrade, /npm run restore -- "\$BACKUP_DIR" --data-root \/var\/lib\/printshopcrm/)
  assert.doesNotMatch(upgrade, /\/var\/backups\/pre-upgrade-/)
})

test('documented snapshot plus artwork archive restores a disposable shop', { skip: process.platform === 'win32' }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-upgrade-recovery-'))
  try {
    const data = join(temp, 'data')
    const shopDir = join(data, 'tenants', 'example')
    const uploads = join(data, 'uploads')
    const backup = join(data, 'backups', 'pre-upgrade-example')
    mkdirSync(shopDir, { recursive: true })
    mkdirSync(uploads)
    const dbPath = join(shopDir, 'printshop.db')
    const db = new DatabaseSync(dbPath)
    db.exec("CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO contacts(name) VALUES ('fixture')")
    db.close()
    writeFileSync(join(uploads, 'proof.txt'), 'synthetic artwork')

    execFileSync(process.execPath, ['--no-warnings', join(repo, 'bin/snapshot.mjs'), data, backup])
    execFileSync('tar', ['czhf', join(backup, 'uploads.tar.gz'), '-C', data, 'uploads'])
    execFileSync('tar', ['tzf', join(backup, 'uploads.tar.gz')])

    const changed = new DatabaseSync(dbPath)
    changed.exec('DELETE FROM contacts')
    changed.close()
    writeFileSync(join(uploads, 'proof.txt'), 'changed artwork')

    execFileSync(process.execPath, ['--no-warnings', join(repo, 'bin/restore.mjs'), backup, '--data-root', data])
    assert.equal(readFileSync(join(uploads, 'proof.txt'), 'utf8'), 'changed artwork', 'the preview must not restore files')

    execFileSync(process.execPath, ['--no-warnings', join(repo, 'bin/restore.mjs'), backup, '--data-root', data, '--yes'])
    const restored = new DatabaseSync(dbPath, { readOnly: true })
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 1)
    restored.close()
    assert.equal(readFileSync(join(uploads, 'proof.txt'), 'utf8'), 'synthetic artwork')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
