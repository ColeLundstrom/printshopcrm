/** Evaluation instances accept inbound requests but never connect to external services.
 * Loaded before the app, including every static import, using node --import.
 * This is an application safeguard for the demo, not an OS security sandbox.
 */
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

const blocked = () => {
  const e = new Error('External services are disabled in this demo. Nothing was sent or charged.')
  e.code = 'PSC_DEMO_NETWORK_BLOCKED'
  throw e
}
net.Socket.prototype.connect = blocked
net.connect = blocked
net.createConnection = blocked
tls.connect = blocked
http.request = blocked
http.get = blocked
https.request = blocked
https.get = blocked
globalThis.fetch = async () => blocked()
syncBuiltinESMExports()
process.env.PSC_DEMO = '1'
