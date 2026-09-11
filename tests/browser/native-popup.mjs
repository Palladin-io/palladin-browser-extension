import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Chrome's real action popup is not exposed as a Playwright Page. Drive its native CDP target.
export async function openNativePopup(worker, profile, extensionId) {
  const [port, endpoint] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
  const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let serial = 0
  const calls = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const call = calls.get(message.id)
    if (!call) return
    calls.delete(message.id)
    clearTimeout(call.timer)
    if (message.error) call.reject(new Error(`Browser protocol error: ${message.error.code}`))
    else call.resolve(message.result)
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { calls.delete(id); reject(new Error(`Browser protocol timeout: ${method}`)) }, 15000)
    calls.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const popupUrl = `chrome-extension://${extensionId}/src/popup/index.html`
  let target = (await send('Target.getTargets')).targetInfos.find((target) => target.url === popupUrl)
  if (!target) {
    try { await worker.evaluate(() => chrome.action.openPopup()) }
    catch (error) { socket.close(); throw error }
    target = (await send('Target.getTargets')).targetInfos.find((target) => target.url === popupUrl)
  }
  if (!target) { socket.close(); throw new Error('Native extension popup did not open') }
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const command = (method, params) => send(method, params, sessionId)
  const wait = async (read, label) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const result = await read()
      if (result) return result
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Native popup timeout: ${label}`)
  }
  const evaluate = async (expression) => (await command('Runtime.evaluate', { expression, returnByValue: true })).result.value
  const clickNode = async (backendNodeId) => {
    await command('DOM.scrollIntoViewIfNeeded', { backendNodeId })
    const { model } = await command('DOM.getBoxModel', { backendNodeId })
    const point = { x: (model.content[0] + model.content[4]) / 2, y: (model.content[1] + model.content[5]) / 2 }
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  return {
    async click(name) {
      const node = await wait(async () => (await command('Accessibility.getFullAXTree')).nodes.find((node) =>
        !node.ignored && node.role?.value === 'button' && node.name?.value === name), name)
      await clickNode(node.backendDOMNodeId)
    },
    async fill(selector, value) {
      await wait(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), selector)
      const { root } = await command('DOM.getDocument')
      const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector })
      const { node } = await command('DOM.describeNode', { nodeId })
      await clickNode(node.backendNodeId)
      await command('Input.insertText', { text: value })
    },
    async hasText(text) { return evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`) },
    // Exercise the same private command as CopyButton, inside the real native
    // popup sender boundary. Only a boolean leaves the browser; no clipboard,
    // synthetic secret, key, or command response enters reports.
    async revealedFieldMatches(vaultId, entryId, field, expected) {
      const { result, exceptionDetails } = await command('Runtime.evaluate', {
        expression: `(async () => { const r = await chrome.runtime.sendMessage(${JSON.stringify({ type: 'vault/reveal', vaultId, entryId, field })}); return r?.ok === true && r.reveal?.value === ${JSON.stringify(expected)} })()`,
        awaitPromise: true, returnByValue: true,
      })
      return !exceptionDetails && result.value === true
    },
    async hasButton(name) { return (await command('Accessibility.getFullAXTree')).nodes.some((node) =>
      !node.ignored && node.role?.value === 'button' && node.name?.value === name) },
    async waitButton(name) { await wait(() => this.hasButton(name), name) },
    async waitText(text) { await wait(() => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), text) },
    async screenshot(file) { const { data } = await command('Page.captureScreenshot'); await writeFile(file, Buffer.from(data, 'base64')) },
    close() { socket.close() },
  }
}
