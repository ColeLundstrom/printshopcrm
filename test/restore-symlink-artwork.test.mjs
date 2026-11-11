import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const node = (...args) => execFileSync(process.execPath, ['--no-warnings', ...args], { encoding: 'utf8' })

test('restoring artwork keeps an external uploads symlink and its previous files', { skip: process.platform === 'win32' }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-restore-linked-art-'))
  try {
    const data = join(temp, 'data')
    const art = join(temp, 'volume', 'uploads')
    const backup = join(data, 'backups', 'before-change')
    mkdirSync(data, { recursive: true })
    mkdirSync(art, { recursive: true })
    chmodSync(art, 0o750)
    symlinkSync(art, join(data, 'uploads'))
    const dbPath = join(data, 'printshop.db')
    const db = new DatabaseSync(dbPath)
    db.exec("CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO contacts(name) VALUES ('fixture')")
    db.close()
    writeFileSync(join(art, 'proof.txt'), 'backed-up artwork')
    node(join(repo, 'bin/snapshot.mjs'), data, backup)
    execFileSync('tar', ['czhf', join(backup, 'uploads.tar.gz'), '-C', data, 'uploads'])

    const changed = new DatabaseSync(dbPath)
    changed.exec('DELETE FROM contacts')
    changed.close()
    writeFileSync(join(art, 'proof.txt'), 'newer artwork')

    node(join(repo, 'bin/restore.mjs'), backup, '--data-root', data)
    assert.ok(lstatSync(join(data, 'uploads')).isSymbolicLink(), 'the preview must preserve the link')
    assert.equal(readFileSync(join(art, 'proof.txt'), 'utf8'), 'newer artwork')

    node(join(repo, 'bin/restore.mjs'), backup, '--data-root', data, '--yes')
    assert.ok(lstatSync(join(data, 'uploads')).isSymbolicLink(), 'the restored shop must still use its persistent volume')
    assert.equal(readFileSync(join(art, 'proof.txt'), 'utf8'), 'backed-up artwork')
    assert.equal(statSync(art).mode & 0o777, 0o750, 'the replacement must retain the writable volume mode')
    const restored = new DatabaseSync(dbPath, { readOnly: true })
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 1)
    restored.close()
    const saved = readdirSync(dirname(art)).filter(n => n.startsWith('.psc-restore-art-'))
    assert.equal(saved.length, 1, 'the previous external artwork needs a recoverable safety copy')
    assert.equal(readFileSync(join(dirname(art), saved[0], 'uploads-previous', 'proof.txt'), 'utf8'), 'newer artwork')

    const changedAgain = new DatabaseSync(dbPath)
    changedAgain.exec('DELETE FROM contacts')
    changedAgain.close()
    rmSync(art, { recursive: true })
    const broken = spawnSync(process.execPath,
      ['--no-warnings', join(repo, 'bin/restore.mjs'), backup, '--data-root', data, '--yes'],
      { encoding: 'utf8' })
    assert.notEqual(broken.status, 0, 'a broken artwork target must stop the restore')
    assert.match(broken.stderr, /broken uploads symlink/)
    const unchanged = new DatabaseSync(dbPath, { readOnly: true })
    assert.equal(unchanged.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 0,
      'the broken artwork target must be detected before any database is overwritten')
    unchanged.close()
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
