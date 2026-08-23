#!/usr/bin/env node
/**
 * Copy a backup archive to Google Drive, so it lives somewhere other than the disk that made it.
 *
 *   node bin/backup-drive.mjs connect            # one-time: mint a refresh token
 *   node bin/backup-drive.mjs upload <file>      # upload one archive, prune old ones
 *   node bin/backup-drive.mjs status             # who is connected, quota, what's stored
 *
 * WHOSE DRIVE: yours. This reads credentials from the environment of the machine it runs on, so
 * every install backs up to the Drive of whoever runs it. There is no shared or default account,
 * and nothing here can reach another operator's Drive.
 *
 * Scope is `drive.file` — the narrowest Google offers. This can only ever see and touch files it
 * created itself. It cannot read your existing documents, and revoking access leaves your Drive
 * exactly as it was apart from the backup folder.
 *
 * Env (see .env.example):
 *   PSC_BACKUP_GDRIVE_CLIENT_ID
 *   PSC_BACKUP_GDRIVE_CLIENT_SECRET
 *   PSC_BACKUP_GDRIVE_REFRESH_TOKEN   ← produced by `connect`
 *   PSC_BACKUP_GDRIVE_FOLDER          optional, default "PrintShopCRM Backups"
 *   PSC_BACKUP_GDRIVE_KEEP            optional, how many archives to retain (default 30)
 */
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  authorizeUrl, exchangeCode, refreshToken as refreshAccessToken,
  ensureFolder, uploadFile, storageQuota, deleteFile,
} from '../lib/gdrive.mjs'

const CLIENT_ID = process.env.PSC_BACKUP_GDRIVE_CLIENT_ID || ''
const CLIENT_SECRET = process.env.PSC_BACKUP_GDRIVE_CLIENT_SECRET || ''
const REFRESH = process.env.PSC_BACKUP_GDRIVE_REFRESH_TOKEN || ''
const FOLDER = process.env.PSC_BACKUP_GDRIVE_FOLDER || 'PrintShopCRM Backups'
const KEEP = Math.max(1, Number(process.env.PSC_BACKUP_GDRIVE_KEEP || 30))
// Out-of-band redirect: the consent screen shows you the code to paste back, so this works on a
// headless server with no callback URL to register.
const OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob'

const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1) }
const ok = (msg) => console.log(`  ${msg}`)
const [cmd, ...args] = process.argv.slice(2)

function requireApp() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    die('Set PSC_BACKUP_GDRIVE_CLIENT_ID and PSC_BACKUP_GDRIVE_CLIENT_SECRET first.\n' +
        '  Create an OAuth client (type: Desktop app) at https://console.cloud.google.com/apis/credentials\n' +
        '  and enable the Google Drive API for that project.')
  }
}

/** An access token for this run. Never persisted — it expires in about an hour anyway. */
async function accessToken() {
  requireApp()
  if (!REFRESH) die('No PSC_BACKUP_GDRIVE_REFRESH_TOKEN. Run:  node bin/backup-drive.mjs connect')
  const t = await refreshAccessToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH })
  if (!t?.accessToken) die('Google refused the refresh token. It may have been revoked — run `connect` again.')
  return t.accessToken
}

switch (cmd) {
  /* ---------------------------------------------------------------- connect */
  case 'connect': {
    requireApp()
    const url = authorizeUrl({ clientId: CLIENT_ID, redirectUri: OOB_REDIRECT, state: 'psc-backup' })
    console.log(`
  1. Open this URL, signed in as the account whose Drive should hold the backups:

${url}

  2. Approve access. Google will show you a code.
  3. Paste it below.
`)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const code = (await rl.question('  Code: ')).trim()
    rl.close()
    if (!code) die('No code entered.')
    const t = await exchangeCode({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code, redirectUri: OOB_REDIRECT })
      .catch((e) => die(`Google rejected the code: ${e.message}`))
    if (!t?.refreshToken) {
      die('Google returned no refresh token. Revoke this app at https://myaccount.google.com/permissions and run connect again.')
    }
    console.log(`
  Add this to your environment (it is a credential — treat it like a password):

    PSC_BACKUP_GDRIVE_REFRESH_TOKEN=${t.refreshToken}

  Then check it with:  node bin/backup-drive.mjs status
`)
    break
  }

  /* ----------------------------------------------------------------- upload */
  case 'upload': {
    const file = args[0] || die('usage: node bin/backup-drive.mjs upload <path-to-archive>')
    let size
    try { size = statSync(file).size } catch { die(`No such file: ${file}`) }
    if (!size) die(`${file} is empty — refusing to upload a zero-byte backup.`)

    const token = await accessToken()
    const folder = await ensureFolder({ accessToken: token, name: FOLDER })
    if (!folder?.id) die(`Could not create or find the "${FOLDER}" folder in Drive.`)

    const name = basename(file)
    const uploaded = await uploadFile({
      accessToken: token,
      name,
      mimeType: 'application/gzip',
      buffer: readFileSync(file),
      folderId: folder.id,
    })
    if (!uploaded?.id) die('Upload failed — nothing was stored.')
    ok(`uploaded ${name} (${(size / 1048576).toFixed(1)} MB) → Drive/${FOLDER}`)

    // Retention, oldest first. Only files this tool created are visible under drive.file, so
    // there is no way for this to delete anything else in the Drive.
    const listed = await listBackups(token, folder.id)
    const doomed = listed.slice(KEEP)
    for (const f of doomed) {
      await deleteFile({ accessToken: token, fileId: f.id }).catch(() => {})
    }
    if (doomed.length) ok(`pruned ${doomed.length} old archive(s), keeping ${KEEP}`)
    break
  }

  /* ----------------------------------------------------------------- status */
  case 'status': {
    const token = await accessToken()
    const quota = await storageQuota({ accessToken: token }).catch(() => null)
    const folder = await ensureFolder({ accessToken: token, name: FOLDER })
    const listed = folder?.id ? await listBackups(token, folder.id) : []
    console.log()
    ok(`folder      : ${FOLDER}`)
    ok(`archives    : ${listed.length} (retention ${KEEP})`)
    if (listed[0]) ok(`most recent : ${listed[0].name}  ${listed[0].createdTime || ''}`)
    if (quota?.limit) {
      const used = Number(quota.usage || 0) / 1073741824
      const cap = Number(quota.limit) / 1073741824
      ok(`drive usage : ${used.toFixed(1)} GB of ${cap.toFixed(1)} GB`)
    }
    console.log()
    break
  }

  default:
    console.log(`
  Off-site backups to Google Drive — your Drive, your credentials.

    node bin/backup-drive.mjs connect          one-time consent, prints a refresh token
    node bin/backup-drive.mjs upload <file>    upload an archive and prune old ones
    node bin/backup-drive.mjs status           connection, retention, quota

  Scope is drive.file: this can only see files it created itself, never the rest of your Drive.
`)
    process.exit(cmd ? 1 : 0)
}

/** Backups in the folder, newest first. */
async function listBackups(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`)
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&fields=files(id,name,createdTime,size)&pageSize=200`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) },
  )
  if (!res.ok) return []
  return (await res.json()).files || []
}
