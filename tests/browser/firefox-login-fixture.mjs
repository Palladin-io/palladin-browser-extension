// Controlled HTTPS document through WebDriver's network fixture. No TLS handshake
// claim; product HTTPS/host/document/fill checks still run in the real browser.
// Input and protocol bodies are never logged. The page starts with empty fields.
import { createInterface } from 'node:readline'
const line = await new Promise(resolve => {
  const reader = createInterface({ input: process.stdin })
  reader.once('line', value => { reader.close(); resolve(value) })
})
const { webSocketUrl, origin } = JSON.parse(line)
const endpoint = new URL(webSocketUrl), site = new URL(origin)
if (endpoint.protocol !== 'ws:' || !['localhost', '127.0.0.1'].includes(endpoint.hostname)
  || origin !== 'https://shared-unlock-login.example.test') throw new Error('Invalid fixture scope')
const html = '<!doctype html><meta charset="utf-8"><title>Synthetic login</title><form><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form><script>window.submitted=false;document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.submitted=true})</script>'
const socket = new WebSocket(webSocketUrl)
const connectionTimeout = setTimeout(() => { process.stderr.write('Fixture startup timed out.\n'); socket.close(); process.exit(1) }, 15000)
let serial = 0
const calls = new Map()
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++serial
  const timer = setTimeout(() => { calls.delete(id); reject(new Error('Fixture timeout')) }, 15000)
  calls.set(id, { resolve, reject, timer })
  socket.send(JSON.stringify({ id, method, params }))
})
socket.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const call = calls.get(message.id)
    if (!call) return
    calls.delete(message.id); clearTimeout(call.timer)
    if (message.type === 'success') call.resolve(message.result)
    else call.reject(new Error('Fixture command rejected'))
  } else if (message.method === 'network.beforeRequestSent' && message.params.isBlocked
    && new URL(message.params.request.url).origin === origin) {
    void send('network.provideResponse', { request: message.params.request.request, statusCode: 200,
      headers: [{ name: 'content-type', value: { type: 'string', value: 'text/html' } }],
      body: { type: 'base64', value: Buffer.from(html).toString('base64') },
    }).catch(() => { process.stderr.write('Fixture response failed.\n'); process.exitCode = 1; socket.close() })
  }
}
socket.onopen = async () => {
  clearTimeout(connectionTimeout)
  try {
    await send('session.subscribe', { events: ['network.beforeRequestSent'] })
    await send('network.addIntercept', { phases: ['beforeRequestSent'], urlPatterns: [{ type: 'pattern', protocol: site.protocol.slice(0, -1), hostname: site.hostname }] })
    process.stdout.write('ready\n')
  } catch { process.stderr.write('Fixture setup failed.\n'); process.exitCode = 1; socket.close() }
}
socket.onerror = () => { clearTimeout(connectionTimeout); process.stderr.write('Fixture connection failed.\n'); process.exitCode = 1 }
