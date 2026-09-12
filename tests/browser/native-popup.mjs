import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Chrome's real action popup is not exposed as a Playwright Page. Drive its native CDP target.
export async function openNativePopup(worker, profile, extensionId) {
  const [port, endpoint] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
  const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let serial = 0
  const calls = new Map()
  socket.onclose = () => {
    for (const call of calls.values()) {
      clearTimeout(call.timer)
      call.reject(new Error('Browser protocol socket closed'))
    }
    calls.clear()
  }
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
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error('Browser protocol socket closed')); return }
    const id = ++serial
    const timer = setTimeout(() => { calls.delete(id); reject(new Error(`Browser protocol timeout: ${method}`)) }, 15000)
    calls.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const popupUrl = `chrome-extension://${extensionId}/src/popup/index.html`
  let target = (await send('Target.getTargets')).targetInfos.find((target) => target.url === popupUrl)
  if (!target) {
    try {
      if (worker) await worker.evaluate(() => chrome.action.openPopup())
      else {
        // After a browser-controlled stop/start, Playwright may retain its old
        // Worker wrapper. Attach the actual current browser target instead.
        const background = (await send('Target.getTargets')).targetInfos.find(info =>
          info.type === 'service_worker' && info.url.startsWith(`chrome-extension://${extensionId}/`))
        if (!background) throw new Error('Native extension worker target missing')
        const attached = await send('Target.attachToTarget', { targetId: background.targetId, flatten: true })
        try {
          const opened = await send('Runtime.evaluate', { expression: 'chrome.action.openPopup()', awaitPromise: true }, attached.sessionId)
          if (opened.exceptionDetails) throw new Error('Native extension popup could not open')
        } finally { await send('Target.detachFromTarget', { sessionId: attached.sessionId }) }
      }
    }
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
  // React may replace a button between AX lookup and pointer dispatch. Observe
  // the actual trusted click on that exact node; never replay an observed click
  // or replace the product callback with a runtime/session command.
  const clickButton = async (backendNodeId) => {
    const { object } = await command('DOM.resolveNode', { backendNodeId })
    if (!object.objectId) return false
    const objectId = object.objectId
    try {
      await command('Runtime.callFunctionOn', { objectId, functionDeclaration: `function() {
        const state = { observed: false, trusted: false, handler: null };
        state.handler = event => { state.observed = true; state.trusted = event.isTrusted; };
        this.__palladinTestClick = state;
        this.addEventListener('click', state.handler, { capture: true, once: true });
      }` })
      await clickNode(backendNodeId)
      const result = await command('Runtime.callFunctionOn', { objectId, returnByValue: true,
        functionDeclaration: 'function() { const s = this.__palladinTestClick; return { observed: s?.observed === true, trusted: s?.trusted === true }; }' })
      if (result.result.value?.observed && !result.result.value.trusted) throw new Error('Untrusted native popup click')
      return result.result.value?.observed === true
    } finally {
      try {
        await command('Runtime.callFunctionOn', { objectId, functionDeclaration: `function() {
          const state = this.__palladinTestClick;
          if (state) this.removeEventListener('click', state.handler, true);
          delete this.__palladinTestClick;
        }` })
      } catch { /* The real action may close its popup document. */ }
      try { await command('Runtime.releaseObject', { objectId }) } catch { /* target closed */ }
    }
  }
  let movement = 0
  return {
    async trustedMouseMove() {
      // Observe a browser-generated input event without invoking the product's
      // activity command or touching its session store/clock.
      await evaluate(`(() => {
        const state = { observed: false, trusted: false };
        globalThis.__palladinTestMovement = state;
        window.addEventListener('mousemove', event => {
          state.observed = true; state.trusted = event.isTrusted;
        }, { once: true });
      })()`)
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8 + (++movement % 2), y: 8 })
      await wait(() => evaluate('globalThis.__palladinTestMovement?.observed === true'), 'native mouse movement')
      const trusted = await evaluate('globalThis.__palladinTestMovement?.trusted === true')
      await evaluate('delete globalThis.__palladinTestMovement')
      if (!trusted) throw new Error('Untrusted native popup mouse movement')
    },
    async inspectTargets() {
      const targets = (await send('Target.getTargets')).targetInfos
      return {
        attachedPopupPresent: targets.some(info => info.targetId === target.targetId),
        popupPresent: targets.some(info => info.url === popupUrl),
        ownWorkerPresent: targets.some(info => info.type === 'service_worker' && info.url.startsWith(`chrome-extension://${extensionId}/`)),
      }
    },
    async click(name, role = 'button') {
      let attempts = 0
      await wait(async () => {
        const node = (await command('Accessibility.getFullAXTree')).nodes.find((node) =>
          !node.ignored && node.role?.value === role && node.name?.value === name)
        if (!node) return false
        attempts += 1
        return clickButton(node.backendDOMNodeId)
      }, `trusted button click: ${name}`)
      return { attempts }
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
    async revealDeniedWhileLocked(vaultId, entryId) {
      const { result, exceptionDetails } = await command('Runtime.evaluate', {
        expression: `(async () => { const r = await chrome.runtime.sendMessage(${JSON.stringify({ type: 'vault/reveal', vaultId, entryId, field: 'password' })}); return r?.ok === false && r.code === 'locked' && !('reveal' in r) })()`,
        awaitPromise: true, returnByValue: true,
      })
      return !exceptionDetails && result.value === true
    },
    async revealDeniedForOtherAccount(vaultId, entryId) {
      const { result, exceptionDetails } = await command('Runtime.evaluate', {
        expression: `(async () => { const r = await chrome.runtime.sendMessage(${JSON.stringify({ type: 'vault/reveal', vaultId, entryId, field: 'password' })}); return r?.ok === false && r.code === 'decrypt-failed' && !('reveal' in r) })()`,
        awaitPromise: true, returnByValue: true,
      })
      return !exceptionDetails && result.value === true
    },
    async hasButton(name) { return (await command('Accessibility.getFullAXTree')).nodes.some((node) =>
      !node.ignored && node.role?.value === 'button' && node.name?.value === name) },
    async waitButton(name) { await wait(() => this.hasButton(name), name) },
    async waitSwitch(name, checked) {
      await wait(async () => (await command('Accessibility.getFullAXTree')).nodes.some(node =>
        !node.ignored && node.role?.value === 'switch' && node.name?.value === name
        && node.properties?.some(property => property.name === 'checked' && String(property.value.value) === String(checked))),
      `switch ${name}: ${checked}`)
    },
    async waitText(text) { await wait(() => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), text) },
    async screenshot(file) { const { data } = await command('Page.captureScreenshot'); await writeFile(file, Buffer.from(data, 'base64')) },
    close() { socket.close() },
  }
}
