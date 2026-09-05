import assert from 'node:assert/strict'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The gateway owns one OS-assigned port throughout the test, including app restarts.
// Every actual app process obtains its own PORT=0 listener; no discovered port is ever
// closed and later reused as though a reservation still existed.
function installListenerReporter(http) {
  const token = process.env.PSC_TEST_LISTENER_TOKEN
  if (process.env.PSC_DEMO !== '1' || !token || typeof process.send !== 'function') throw Error('Private test listener channel required')
  const listen = http.Server.prototype.listen
  http.Server.prototype.listen = function (...args) {
    if (String(args[0]) !== '0' || args[1] !== '127.0.0.1') throw Error('Test app must request an OS-owned loopback listener')
    this.once('listening', () => {
      const address = this.address()
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || !address.port) throw Error('Unexpected test listener address')
      process.send({ type: 'psc-test-listener', token, pid: process.pid, port: address.port })
    })
    return listen.apply(this, args)
  }
}

function deadline(promise, ms, message) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms) })])
    .finally(() => clearTimeout(timer))
}

export async function createHttpTestServer() {
  let current = null, targetPort = null, closed = false
  const sockets = new Set()
  const gateway = createServer(incoming => {
    if (!targetPort) { incoming.destroy(); return }
    const upstream = createConnection({ host: '127.0.0.1', port: targetPort })
    sockets.add(incoming); sockets.add(upstream)
    incoming.on('error', () => upstream.destroy())
    upstream.on('error', () => incoming.destroy())
    incoming.once('close', () => { sockets.delete(incoming); upstream.destroy() })
    upstream.once('close', () => { sockets.delete(upstream); incoming.destroy() })
    incoming.pipe(upstream); upstream.pipe(incoming)
  })
  await new Promise((resolve, reject) => {
    gateway.once('error', reject)
    gateway.listen(0, '127.0.0.1', () => { gateway.removeListener('error', reject); resolve() })
  })
  const port = gateway.address().port, base = `http://127.0.0.1:${port}`
  const drainSockets = async () => {
    await Promise.all([...sockets].map(socket => new Promise(resolve => {
      socket.once('close', resolve)
      socket.destroy()
    })))
  }
  const stop = async () => {
    const running = current
    targetPort = null
    if (running) running.state = 'stopping'
    await drainSockets()
    if (!running) return null
    if (!running.didClose) {
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGTERM')
      try { await deadline(running.exit, 3000, 'Test server did not stop gracefully') }
      catch {
        if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGKILL')
        await deadline(running.exit, 10000, 'Test server process or stdio did not close after SIGKILL')
      }
    }
    current = null
    return running.result
  }
  return {
    port, base,
    get child() { return current?.child || null },
    get currentAddress() { return current?.address || null },
    async start({ cwd, env, args = ['server.mjs'], onOutput = () => {} }) {
      assert.equal(closed, false, 'test gateway is closed')
      assert.equal(current, null, 'stop and await the existing child before starting another')
      assert.ok(args.length && args.at(-1) === 'server.mjs', 'entry point must be the actual server')
      const token = randomUUID(), preload = join(cwd, 'http-test-listener.mjs')
      // Workers inherit --import. Only the main app listener belongs on this IPC channel;
      // checkpoint workers must keep their normal preloads and unmodified HTTP prototype.
      writeFileSync(preload, "import http from 'node:http';\nimport {isMainThread} from 'node:worker_threads';\nif(isMainThread)(" + installListenerReporter.toString() + ')(http);\n', { mode: 0o600 })
      const child = spawn(process.execPath, [...args.slice(0, -1), '--import', pathToFileURL(preload).href, args.at(-1)], {
        cwd, env: { ...env, PORT: '0', PSC_HOST: '127.0.0.1', PSC_PUBLIC_URL: base, PSC_TEST_LISTENER_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      const running = { child, state: 'starting', didExit: false, didClose: false, result: null, address: null, boot: '' }
      current = running
      child.once('exit', () => {
        running.didExit = true; running.state = 'closed'
        if (current === running) { targetPort = null; for (const socket of sockets) socket.destroy() }
      })
      running.exit = new Promise(resolve => child.once('close', (code, signal) => {
        running.didClose = true; running.state = 'closed'
        if (current === running) { targetPort = null; for (const socket of sockets) socket.destroy() }
        running.result = { pid: child.pid, code, signal }; resolve(running.result)
      }))
      let readyResolve, readyReject
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
      const checkReady = () => {
        if (current === running && running.state === 'starting' && !running.didExit && running.address && running.boot.includes('(ws /ws live')) {
          running.state = 'ready'
          targetPort = running.address.port
          readyResolve(running.address)
        }
      }
      child.on('message', message => {
        if (message?.type !== 'psc-test-listener' || message.token !== token || message.pid !== child.pid) return
        if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) { readyReject(Error('Invalid child listener address')); return }
        running.address = { pid: child.pid, port: message.port }; checkReady()
      })
      child.on('error', error => readyReject(error))
      child.once('close', () => readyReject(Error('Actual test server closed before startup:\n' + running.boot)))
      for (const output of [child.stdout, child.stderr]) output.on('data', bytes => {
        const text = String(bytes); running.boot += text; onOutput(text); checkReady()
      })
      try { return await deadline(ready, 30000, 'Actual test server did not report its bound listener and ready log') }
      catch (error) { await stop(); throw error }
    },
    stop,
    async assertPortOwned() {
      const rival = createServer()
      const result = await new Promise((resolve, reject) => {
        rival.once('error', error => resolve(error.code))
        rival.listen(port, '127.0.0.1', () => rival.close(() => reject(Error('Gateway port unexpectedly became available'))))
      })
      assert.equal(result, 'EADDRINUSE', 'gateway keeps exclusive port ownership during restart')
    },
    async close() {
      if (closed) return
      await stop()
      await drainSockets()
      await new Promise((resolve, reject) => gateway.close(error => error ? reject(error) : resolve()))
      closed = true
      assert.equal(gateway.listening, false)
      assert.equal(sockets.size, 0, 'gateway forwards no sockets after teardown')
    },
  }
}
