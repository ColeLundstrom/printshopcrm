import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('a backup with a non-ok quick_check result fails without pruning older archives', {
  skip: process.platform === 'win32' ? 'deploy/backup.sh is the POSIX server backup script' : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'psc-backup-integrity-'))
  try {
    const data = join(root, 'data')
    const backups = join(root, 'backups')
    const bin = join(root, 'bin')
    const app = join(root, 'app')
    const uploadMarker = join(root, 'offsite-was-called')
    mkdirSync(data)
    mkdirSync(backups)
    mkdirSync(bin)
    mkdirSync(join(app, 'bin'), { recursive: true })
    writeFileSync(join(app, 'bin', 'backup-drive.mjs'),
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.PSC_TEST_MARKER, 'called')")

    const sqlite = spawnSync('sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).stdout.trim()
    assert.ok(sqlite, 'sqlite3 CLI is required for this POSIX backup test')
    const created = spawnSync(sqlite, [join(data, 'control.db'), 'CREATE TABLE staff(id INTEGER PRIMARY KEY);'], { encoding: 'utf8' })
    assert.equal(created.status, 0, created.stderr)

    // Model a SQLite integrity report that prints an error row but exits 0.
    writeFileSync(join(bin, 'sqlite3'), `#!/bin/sh
if [ "$2" = 'PRAGMA quick_check;' ]; then
  printf 'row 1 missing from index\n'
  exit 0
fi
exec '${sqlite.replaceAll("'", "'\\''")}' "$@"
`, { mode: 0o755 })

    const old = join(backups, '20260101-030000.tar.gz')
    writeFileSync(old, 'last known good archive')
    const aged = new Date(Date.now() - 60 * 864e5)
    utimesSync(old, aged, aged)

    const run = spawnSync('bash', [fileURLToPath(new URL('../deploy/backup.sh', import.meta.url))], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        DATA_ROOT: data, BACKUP_ROOT: backups, KEEP_DAYS: '30', APP_DIR: app,
        PSC_BACKUP_GDRIVE_REFRESH_TOKEN: 'fixture-only', PSC_TEST_MARKER: uploadMarker },
    })
    assert.equal(run.status, 1, run.stderr + run.stdout)
    assert.match(run.stderr, /VERIFY FAILED.*quick_check/i)
    assert.match(run.stderr, /not pruning old backups/i)
    assert.ok(existsSync(old), 'a failed verification must retain older backups')
    assert.equal(existsSync(uploadMarker), false, 'a failed verification must not upload the bad archive')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
