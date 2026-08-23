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
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
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

/**
 * Loopback redirect. Google retired the out-of-band flow
 * (`urn:ietf:wg:oauth:2.0:oob`) in 2022 and now rejects it outright, so a desktop-app client has to
 * come back to http://127.0.0.1:<port>. Add that exact URI to the client's "Authorized redirect
 * URIs" in Google Cloud.
 *
 * Two ways to finish, because this usually runs on a headless server:
 *   default    a tiny local server catches the redirect (use an SSH tunnel to reach it)
 *   --manual   you approve in any browser and paste the redirected URL back
 */
const LOOPBACK_PORT = Number(process.env.PSC_BACKUP_GDRIVE_PORT || 4765)
const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}`

const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1) }
const ok = (msg) => console.log(`  ${msg}`)
const [cmd, ...args] = process.argv.slice(2)

function requireApp() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    die('Set PSC_BACKUP_GDRIVE_CLIENT_ID and PSC_BACKUP_GDRIVE_CLIENT_SECRET first.\n' +
        '  At https://console.cloud.google.com/apis/credentials create an OAuth client of type\n' +
        `  "Web application", add ${LOOPBACK_REDIRECT} to its Authorized redirect URIs, and\n` +
        '  enable the Google Drive API for that project.')
  }
}

/** An access token for this run. Never persisted — it expires in about an hour anyway. */
async function accessToken() {
  requireApp()
  if (!REFRESH) die('No PSC_BACKUP_GDRIVE_REFRESH_TOKEN. Run:  node bin/backup-drive.mjs connect')
  const t = await refreshAccessToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH })
  // Same non-throwing contract: report what Google actually said rather than guessing.
  if (!t?.ok || !t.accessToken) {
    die(`Google refused the refresh token: ${t?.error || 'no access token returned'}\n` +
        '  If it was revoked or the client secret changed, run:  node bin/backup-drive.mjs connect')
  }
  return t.accessToken
}

switch (cmd) {
  /* ---------------------------------------------------------------- connect */
  case 'connect': {
    requireApp()
    const manual = args.includes('--manual')
    // CSRF: Google echoes this back; a mismatch means the response isn't the one we asked for.
    const state = `psc-${randomBytes(12).toString('hex')}`
    const url = authorizeUrl({ clientId: CLIENT_ID, redirectUri: LOOPBACK_REDIRECT, state })

    console.log(`
  Add this to your OAuth client's "Authorized redirect URIs" in Google Cloud first:

      ${LOOPBACK_REDIRECT}

  Then open this URL, signed in as the account whose Drive should hold the backups:

${url}
`)

    let code
    if (manual) {
      console.log(`  Approve, then copy the URL your browser lands on — it will look like a failed
  page at ${LOOPBACK_REDIRECT}/?code=… — and paste the whole thing below.\n`)
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const pasted = (await rl.question('  Redirected URL: ')).trim()
      rl.close()
      if (!pasted) die('Nothing pasted.')
      let parsed
      try { parsed = new URL(pasted) } catch { die('That is not a URL. Paste the whole address bar, starting with http://127.0.0.1') }
      if (parsed.searchParams.get('error')) die(`Google returned an error: ${parsed.searchParams.get('error')}`)
      if (parsed.searchParams.get('state') !== state) die('State mismatch — that URL is from a different attempt. Run connect again.')
      code = parsed.searchParams.get('code')
      if (!code) die('No ?code= in that URL.')
    } else {
      console.log(`  Waiting for the redirect on ${LOOPBACK_REDIRECT} …
  (headless server? forward it first:  ssh -L ${LOOPBACK_PORT}:127.0.0.1:${LOOPBACK_PORT} <user>@<host>
   or re-run with --manual and paste the URL instead)\n`)
      code = await new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
          const q = new URL(req.url, LOOPBACK_REDIRECT).searchParams
          const fail = q.get('error')
          const good = !fail && q.get('state') === state && q.get('code')
          res.writeHead(good ? 200 : 400, { 'Content-Type': 'text/html' })
          res.end(`<body style="font:16px system-ui;padding:3rem">${good
            ? '<h2>Connected.</h2><p>Backups will upload to this Drive. You can close this tab.</p>'
            : `<h2>Not connected</h2><p>${fail || 'state mismatch'}</p>`}</body>`)
          server.close()
          if (good) resolve(q.get('code'))
          else reject(new Error(fail || 'state mismatch — run connect again'))
        })
        server.on('error', (e) => reject(new Error(
          e.code === 'EADDRINUSE'
            ? `port ${LOOPBACK_PORT} is busy — set PSC_BACKUP_GDRIVE_PORT to a free one`
            : e.message)))
        server.listen(LOOPBACK_PORT, '127.0.0.1')
        // Don't sit open forever on a server nobody is watching.
        setTimeout(() => { server.close(); reject(new Error('timed out after 5 minutes')) }, 300_000).unref?.()
      }).catch((e) => die(e.message))
    }

    // gdrive.mjs never throws — it reports {ok:false,error}. Surface Google's own message, or a
    // wrong client secret reads as "no refresh token" and sends you off revoking permissions for
    // no reason.
    const t = await exchangeCode({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code, redirectUri: LOOPBACK_REDIRECT })
    if (!t?.ok) {
      die(`Google rejected the exchange: ${t?.error || 'unknown error'}\n` +
          `  Check PSC_BACKUP_GDRIVE_CLIENT_ID / _SECRET, and that ${LOOPBACK_REDIRECT} is listed\n` +
          '  under the client\'s Authorized redirect URIs.')
    }
    if (!t.refreshToken) {
      die('Google accepted the code but returned no refresh token — that happens when the account\n' +
          '  has already consented. Revoke it at https://myaccount.google.com/permissions and re-run connect.')
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
