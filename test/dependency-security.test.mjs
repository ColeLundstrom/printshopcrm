import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import express from 'express'
import multer from 'multer'
import nodemailer from 'nodemailer'
import { dnsCache, resolveHostname } from 'nodemailer/lib/shared'

// Every fixture is synthetic. SMTP uses JSON transport, DNS uses a seeded cache, and
// multipart requests are in-memory streams. No provider, DNS or HTTP call is made.
function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

function deadline(promise, message) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 5000)
  })]).finally(() => clearTimeout(timer))
}

function multipartRequest() {
  const request = new PassThrough()
  request.headers = {
    'content-type': 'multipart/form-data; boundary=psc-security-fixture',
    'transfer-encoding': 'chunked',
  }
  return request
}

const filePart = '--psc-security-fixture\r\n' +
  'Content-Disposition: form-data; name="file"; filename="fixture.txt"\r\n' +
  'Content-Type: text/plain\r\n\r\n' +
  'fixture upload\r\n'

// GHSA-jqcg-44mw-7w3h: use Express's actual compiled trust function and req.ip,
// rather than duplicating proxy-addr's implementation or changing app configuration.
test('Express rejects unrelated IPv4 clients for short IPv6 trust subnets', () => {
  const app = express()
  const request = Object.assign(Object.create(app.request), {
    app, socket: { remoteAddress: '203.0.113.9' },
    headers: { 'x-forwarded-for': '198.51.100.24' },
  })
  for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
    app.set('trust proxy', subnet)
    assert.equal(request.ip, '203.0.113.9', subnet)
    assert.deepEqual(request.ips, [], subnet)
  }
  for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    app.set('trust proxy', subnet)
    request.socket.remoteAddress = '10.1.2.3'
    assert.equal(request.ip, '198.51.100.24', subnet)
  }
  app.set('trust proxy', 1)
  assert.equal(request.ip, '198.51.100.24', 'the supported single-proxy hop still works')
  app.set('trust proxy', false)
  assert.equal(request.ip, '10.1.2.3', 'direct deployments ignore forwarded addresses')
})

// GHSA-6vj9-mwq6-2f5v. A valid cache entry means resolveHostname must not perform
// DNS. The attacker name is deliberately present to model the old cache format.
test('SMTP DNS cache keeps each transport TLS identity separate', async () => {
  const host = 'psc-security-cache.example.test'
  dnsCache.set(host, {
    expires: Date.now() + 60_000,
    value: { addresses: ['127.0.0.1'], servername: 'attacker.example.test' },
  })
  try {
    for (const servername of ['victim.example.test', 'another.example.test']) {
      const result = await new Promise((resolve, reject) => {
        resolveHostname({ host, servername }, (error, value) => error ? reject(error) : resolve(value))
      })
      assert.equal(result.cached, true)
      assert.equal(result.host, '127.0.0.1')
      assert.equal(result.servername, servername)
    }
  } finally { dnsCache.delete(host) }
})

// GHSA-8vvx-rff5-p5rq and GHSA-g57g-f23g-4646: compile mail without opening a
// socket, and inspect the actual envelope rather than assuming parser output is safe.
test('SMTP compilation bounds nested recipients and preserves envelope identity', async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true })
  try {
    const deeplyNested = JSON.parse('['.repeat(5000) + '"buyer@example.test"' + ']'.repeat(5000))
    const nested = await transport.sendMail({
      from: 'shop@example.test', to: deeplyNested, subject: 'Fixture', text: 'Synthetic mail only',
    })
    assert.deepEqual(nested.envelope, { from: 'shop@example.test', to: ['buyer@example.test'] })
    const quoted = await transport.sendMail({
      from: 'shop@example.test', to: '"buyer"@example.test(note)unwanted.test',
      subject: 'Fixture', text: 'Synthetic mail only',
    })
    assert.deepEqual(quoted.envelope.to, ['buyer@example.test'])
    assert.equal(JSON.parse(quoted.message).subject, 'Fixture')
  } finally { transport.close() }
})

// GHSA-v53p-9fqp-m79j and GHSA-prgh-xp8r-p3m5. A child deadline prevents a
// reintroduced synchronous parser DoS from freezing the whole regression runner.
test('SMTP address parsing finishes bounded adversarial headers', () => {
  const parser = import.meta.resolve('nodemailer/lib/addressparser')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import parse from ${JSON.stringify(parser)};
    assert.ok(Array.isArray(parse(' >' + '>[x][x]'.repeat(40000))));
    assert.ok(Array.isArray(parse('a' + '@b(c)'.repeat(130000))));
    console.log('bounded parser fixtures completed');
  `], { encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 })
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stderr)
  assert.match(child.stdout, /bounded parser fixtures completed/)
})

// GHSA-3pph-fpjx-jg34: hold filename resolution until after the middleware's
// abort cleanup has completed. This deterministically hits the late-write race.
test('aborted disk uploads remove files whose filename resolves after cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'psc-upload-security-'))
  const request = multipartRequest()
  const entered = deferred(), handled = deferred(), removed = deferred()
  let releaseFilename
  const storage = multer.diskStorage({
    destination: directory,
    filename(_request, _file, callback) {
      releaseFilename = () => callback(null, 'fixture.txt')
      entered.resolve()
    },
  })
  const handleFile = storage._handleFile.bind(storage)
  storage._handleFile = (req, file, callback) => handleFile(req, file, (error, result) => {
    callback(error, result)
    handled.resolve({ error, result })
  })
  const removeFile = storage._removeFile.bind(storage)
  storage._removeFile = (req, file, callback) => removeFile(req, file, error => {
    callback(error)
    removed.resolve(error)
  })
  const completed = new Promise(resolve => multer({ storage }).single('file')(request, {}, resolve))
  try {
    request.write(filePart + '--psc-security-fixture\r\n' +
      'Content-Disposition: form-data; name="unfinished"\r\n\r\n')
    await deadline(entered.promise, 'filename callback was not reached')
    request.destroy(new Error('synthetic upload aborted'))
    const error = await deadline(completed, 'aborted upload middleware did not finish')
    assert.match(error.message, /synthetic upload aborted/)
    releaseFilename()
    const result = await deadline(handled.promise, 'late storage callback did not finish')
    if (!result.error) {
      assert.ifError(await deadline(removed.promise, 'late upload was orphaned instead of removed'))
    }
    assert.deepEqual(await readdir(directory), [])
  } finally {
    request.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test('normal disk and memory uploads preserve bytes and accept exact file limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'psc-upload-normal-'))
  try {
    for (const storage of [multer.diskStorage({ destination: directory }), multer.memoryStorage()]) {
      const request = multipartRequest()
      const completed = new Promise(resolve => multer({ storage,
        limits: { fileSize: Buffer.byteLength('fixture upload'), files: 1, parts: 1 },
      }).single('file')(request, {}, resolve))
      try {
        request.end(filePart + '--psc-security-fixture--\r\n')
        assert.ifError(await deadline(completed, 'normal upload did not finish'))
        assert.equal(request.file.originalname, 'fixture.txt')
        const contents = request.file.buffer || await readFile(request.file.path)
        assert.equal(contents.toString(), 'fixture upload')
      } finally { request.destroy() }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
