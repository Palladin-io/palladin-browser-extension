import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCaptureApi, allowCaptureApi } from './capture-api.mjs'
import { openNativePopup, attachNativeSidePanel } from './native-popup.mjs'
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs'
import { validateBuiltManifest } from '../../scripts/validate-built-manifest.mjs'

// Entirely synthetic mechanism fixtures; no production website acceptance implied.
const { chromium } = await import(process.env.PALLADIN_PLAYWRIGHT_MODULE ?? 'playwright')
const api = await createCaptureApi()
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-secret-capture-'))
const artifacts = path.resolve('test-results/secret-capture')
await mkdir(artifacts, { recursive: true })
const pan = '4111111111111111'
const cvv = '739'
const key = index => ['sk', 'test', `SyntheticCapture${String(index).padStart(3, '0')}abcdefghijklmnopqrstuv`].join('_')
const testedSecrets = [pan, '5555555555554444', '378282246310005', '4000000000000002', '6011111111111117', api.password]
const failures = []
let context, worker, popup, extensionId, page, cdp, source, sourceFrameId
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async (check, label, timeout = 12000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await pause(100) }
  throw Error(`Acceptance timeout: ${label}`)
}
const run = async (name, test) => {
  try { await test(); console.log(`PASS: ${name}`) }
  catch (error) {
    failures.push(name); console.error(`FAIL: ${name}: ${error.message}`)
    if (popup) console.error('Value-free popup state', {
      review: await popup.hasText('Save captured item'), duplicate: await popup.hasText('This exact item is already'),
      expired: await popup.hasText('This capture expired'), error: await popup.hasText('Could not save'),
      saveButton: await popup.hasButton('Save entry'), writes: api.writes.length,
    })
  }
  finally { if (popup) { try { await popup.dismiss() } catch { popup.close() } popup = null } }
}
const nodes = async () => (await cdp.send('Accessibility.getFullAXTree', sourceFrameId ? { frameId: sourceFrameId } : {})).nodes
const noticeButton = async () => (await nodes()).find(node => !node.ignored && node.role?.value === 'button'
  && ['Review in Palladin', 'Sprawdź w Palladin'].includes(node.name?.value))
async function openReview() {
  await wait(noticeButton, 'closed notice')
  assert.equal(await source.locator('palladin-capture').evaluate(host => host.shadowRoot), null, 'Notice uses closed shadow')
  assert.equal(await page.locator('palladin-capture input').count(), 0)
  let model
  await wait(async () => {
    const node = await noticeButton()
    if (!node) return false
    try { model = (await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId })).model; return true }
    catch { return false } // Notice may re-render before any pointer event is dispatched.
  }, 'live notice layout')
  await page.mouse.click((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2)
  popup = await attachNativeSidePanel(profile, extensionId)
  await popup.waitText('Save captured item')
  await popup.click('Review in Palladin')
  await popup.waitButton('Save entry')
}
async function visit(kind, index = 0, keepSurface = false) {
  if (popup && !keepSurface) { try { await popup.dismiss() } catch { popup.close() } popup = null }
  await page.bringToFront()
  source = page; sourceFrameId = undefined
  await page.goto(`https://capture-${index}.example.test/${kind}?case=${index}`)
  // Observe the real content controller's startup request; never inject a candidate.
  await wait(() => worker.evaluate(url => globalThis.secretCaptureReady.includes(url), page.url()), 'content status handshake')
  await pause(450)
}
async function noCapture() {
  await pause(900)
  popup = await openNativePopup(worker, profile, extensionId)
  await popup.waitText('Personal')
  assert.equal(await popup.hasText('Save captured item'), false, 'No pending capture')
}
async function saveKey(index, destination = 0) {
  const count = api.writes.length
  await openReview()
  assert.equal(api.writes.length, count, 'Review never writes')
  if (index === 1) {
    await popup.dismiss(); popup = await openNativePopup(worker, profile, extensionId)
    await popup.waitText('Save captured item'); await popup.click('Review in Palladin'); await popup.waitButton('Save entry')
  }
  assert(await popup.secretCaptureFieldsMatch({ 'input[type="password"]': key(index) }))
  if (destination) await popup.select('.capture-prompt > label select', api.vaults[destination].detail.id)
  if (index === 1) await popup.screenshot(path.join(artifacts, 'native-key-editor-masked.png'))
  await popup.click('Save entry')
  await wait(() => api.writes.length === count + 1, 'explicit encrypted key write')
  const write = api.writes.at(-1)
  const secret = await api.decrypt(write)
  assert.equal(secret.entryType, 'key')
  assert(secret.content.value === key(index), 'Exact captured key roundtrip')
  assert.equal(write.vaultId, api.vaults[destination].detail.id)
  assert(!JSON.stringify(write.request).includes(key(index)), 'Mutation is ciphertext')
}
async function saveCard({ expectedName = '', month = '', year = '', number = pan, reviewOpen = false } = {}) {
  const count = api.writes.length
  if (!reviewOpen) await openReview()
  assert.equal(api.writes.length, count)
  assert(await popup.secretCaptureFieldsMatch({ 'input[autocomplete="cc-name"]': expectedName,
    'input[autocomplete="cc-exp-month"]': month, 'input[autocomplete="cc-exp-year"]': year,
    'input[type="password"][inputmode="numeric"][maxlength="32"]': number,
    'input[type="password"][maxlength="4"]': '' }), 'Only source-local card fields; CVV omitted')
  if (!expectedName) await popup.fill('input[autocomplete="cc-name"]', 'Synthetic Cardholder')
  if (!month) await popup.fill('input[autocomplete="cc-exp-month"]', '12')
  if (!year) await popup.fill('input[autocomplete="cc-exp-year"]', '2031')
  await popup.click('Save entry')
  await wait(() => api.writes.length === count + 1, 'explicit encrypted card write')
  const write = api.writes.at(-1)
  const secret = await api.decrypt(write)
  assert.equal(secret.entryType, 'creditCard')
  assert(secret.content.cardNumber === number, 'Normalized PAN roundtrip')
  assert(secret.content.cardholderName === (expectedName || 'Synthetic Cardholder'), 'Cardholder encrypted roundtrip')
  assert(secret.content.expiryMonth === (month || '12'), 'Expiry month encrypted roundtrip')
  assert(secret.content.expiryYear === (year || '2031'), 'Expiry year encrypted roundtrip')
  assert(secret.content.cvv == null, 'CVV is not automatically retained')
  assert.equal(write.request.deliveryPolicy, 'injectOnly')
  assert(!JSON.stringify(write.request).includes(number), 'Card mutation is ciphertext')
}
try {
  const extension = path.join(profile, 'dist/chromium')
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024 })
  cacheBustContentLoaders(profile, 'chromium'); validateBuiltManifest(profile, 'chromium')
  await allowCaptureApi(extension, api.url)
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] })
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  extensionId = new URL(worker.url()).host
  await worker.evaluate(() => {
    globalThis.secretCaptureReady = []
    globalThis.secretCaptureTabs = {}
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message.channel === 'palladin.secret-capture.v1' && message.type === 'status') {
        globalThis.secretCaptureReady.push(sender.url)
        globalThis.secretCaptureTabs[sender.url] = sender.tab.id
      }
    })
  })
  await context.route('https://**/*', route => {
    const url = new URL(route.request().url())
    if (!url.hostname.endsWith('.example.test')) return route.abort()
    return route.fulfill({ contentType: 'text/html', body: fixture(url) })
  })
  const onboarding = context.pages().find(p => p.url().includes('/onboarding/'))
    ?? await context.waitForEvent('page', { predicate: p => p.url().includes('/onboarding/') })
  await onboarding.close()
  popup = await openNativePopup(worker, profile, extensionId)
  await popup.click('Continue to Palladin'); await popup.waitButton('Sign in')
  assert.equal((await popup.configureConnection({ name: 'Synthetic secret API', apiUrl: api.url,
    webUrl: api.url, allowHttp: true, sharedUnlockEnabled: false })).ok, true)
  await popup.fill('input[type="email"]', api.email); await popup.fill('input[type="password"]', api.password)
  await popup.click('Sign in'); await popup.waitText('No entries yet.')
  await popup.dismiss(); popup = null
  page = await context.newPage(); cdp = await context.newCDPSession(page)
  for (const [index, kind] of [[1, 'generated'], [2, 'readonly'], [3, 'shadow'], [4, 'replacement']]) {
    testedSecrets.push(key(index))
    await run(`key ${kind}: trusted action, closed notice, native editor, encrypted roundtrip`, async () => {
      await visit(kind, index)
      if (kind !== 'readonly') await page.getByRole('button', { name: '生成 🔑' }).click()
      await saveKey(index, index === 2 ? 1 : 0)
    })
  }
  await run('PAN-first card, field enrichment, one pending draft and injectOnly encrypted save', async () => {
    await visit('card', 5)
    await page.locator('[autocomplete="cc-number"]').fill(pan); await pause(600)
    await page.locator('[autocomplete="cc-name"]').fill('Synthetic Cardholder'); await pause(600)
    await page.locator('[autocomplete="cc-exp-month"]').fill('12'); await pause(600)
    await page.locator('[autocomplete="cc-exp-year"]').fill('2031')
    await page.locator('[autocomplete="cc-csc"]').fill(cvv); await page.getByRole('heading').click(); await pause(600)
    await saveCard({ expectedName: 'Synthetic Cardholder', month: '12', year: '2031' })
    await popup.dismiss(); popup = await openNativePopup(worker, profile, extensionId)
    await pause(300)
    assert.equal(await popup.hasText('Save captured item'), false, 'Same PAN form enrichment must not queue another prompt')
  })
  await run('already-open side panel previews and polls PAN-first card without freezing before explicit Review', async () => {
    // Open the actual panel through a prior notice, dismiss that choice, and keep the panel open.
    await visit('generated', 18); await page.getByRole('button', { name: '生成 🔑' }).click()
    await openReview(); await popup.click('Dismiss')
    await visit('card', 16, true)
    await page.locator('[autocomplete="cc-number"]').fill('4000000000000002')
    await popup.waitButton('Review in Palladin')
    await pause(5_100) // Exercise the actual automatic get poll before the user chooses Review.
    await page.locator('[autocomplete="cc-name"]').fill('Synthetic Cardholder'); await pause(600)
    await page.locator('[autocomplete="cc-exp-month"]').fill('12'); await pause(600)
    await page.locator('[autocomplete="cc-exp-year"]').fill('2031'); await page.getByRole('heading').click(); await pause(600)
    await popup.click('Review in Palladin'); await popup.waitButton('Save entry')
    await saveCard({ expectedName: 'Synthetic Cardholder', month: '12', year: '2031', number: '4000000000000002', reviewOpen: true })
  })
  await run('external form-associated PAN and fields capture without unrelated sibling metadata', async () => {
    await visit('external', 17)
    await page.evaluate(() => { globalThis.expiryChanges = []; document.addEventListener('change', event => {
      if (event.target instanceof HTMLSelectElement) globalThis.expiryChanges.push(event.isTrusted)
    }) })
    await page.locator('[autocomplete="cc-number"]').fill('6011111111111117')
    await page.getByRole('heading').click(); await pause(600)
    for (const selector of ['select[autocomplete="cc-exp-month"]', 'select[autocomplete="cc-exp-year"]']) {
      await page.locator(selector).focus(); await page.locator(selector).press('End'); await pause(600)
    }
    assert.deepEqual(await page.evaluate(() => globalThis.expiryChanges), [true, true], 'Actual trusted select changes after PAN-first observation')
    await saveCard({ expectedName: 'Synthetic External', month: '12', year: '2031', number: '6011111111111117' })
  })
  await run('standalone PAN in accessible cross-origin iframe completes missing fields without unrelated metadata', async () => {
    await visit('iframe', 6)
    const frame = page.frameLocator('iframe')
    source = page.frames().find(frame => frame.url().startsWith('https://payment.example.test/'))
    sourceFrameId = (await cdp.send('Page.getFrameTree')).frameTree.childFrames[0].frame.id
    await wait(() => worker.evaluate(url => globalThis.secretCaptureReady.includes(url), source.url()), 'iframe status handshake')
    await pause(450)
    await frame.locator('[autocomplete="cc-number"]').fill('5555555555554444')
    await frame.locator('h1').click()
    await pause(600)
    // The notice belongs to the addressed frame; its AX backend node remains on this target.
    await saveCard({ number: '5555555555554444' })
    await popup.dismiss(); popup = null
    await frame.locator('[autocomplete="cc-number"]').fill(pan); await pause(600)
    await openReview()
    const count = api.writes.length
    await source.goto('https://payment.example.test/blank')
    await wait(async () => !(await popup.hasText('Save captured item')), 'editor removed on own frame navigation', 1_500)
    assert.equal(await popup.hasButton('Save entry'), false)
    assert.equal(api.writes.length, count)
  })
  await run('no-autocomplete payment structure detects PAN and local month input', async () => {
    await visit('structural', 7)
    await page.locator('input[type="month"]').fill('2032-11')
    await page.locator('#number').fill('378282246310005'); await page.getByRole('heading').click(); await pause(600)
    await saveCard({ month: '11', year: '2032', number: '378282246310005' })
  })
  await run('synthetic card events and hidden/SVG/documentation key outputs produce no capture', async () => {
    const count = api.writes.length
    await visit('negative', 8)
    await page.locator('[autocomplete="cc-number"]').evaluate((input, value) => {
      input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }))
    }, pan)
    await noCapture(); assert.equal(api.writes.length, count)
  })
  await run('saved exact key duplicate creates no second entry', async () => {
    await visit('readonly', 1)
    const count = api.writes.length
    await openReview()
    await popup.watchText('This exact item is already in the selected Vault. Nothing was changed.')
    await popup.click('Save entry')
    await wait(() => popup.sawWatchedText(), 'actual duplicate feedback')
    assert.equal(api.writes.length, count)
  })
  await run('repeated mutations reuse candidate; dismiss suppresses it', async () => {
    await visit('generated', 9)
    await page.getByRole('button', { name: '生成 🔑' }).click()
    await wait(noticeButton, 'initial candidate')
    for (let n = 0; n < 4; n++) { await page.locator('#result').evaluate(el => { el.textContent = el.textContent }); await pause(400) }
    await openReview(); await popup.click('Dismiss')
    await popup.dismiss(); popup = null
    await page.locator('#result').evaluate(el => { el.textContent = el.textContent })
    await noCapture()
  })
  await run('same PAN in two forms stays separate and never mixes local cardholder fields', async () => {
    await visit('two-forms', 14)
    const count = api.writes.length
    for (const id of ['one', 'two']) {
      await page.locator(`#${id} [autocomplete="cc-number"]`).fill(pan)
      await page.locator(`#${id} [autocomplete="cc-name"]`).fill(`Synthetic ${id}`)
      await page.getByRole('heading').click(); await pause(500)
    }
    await openReview()
    assert(await popup.secretCaptureFieldsMatch({ 'input[autocomplete="cc-name"]': 'Synthetic one' }))
    await popup.click('Dismiss'); await popup.dismiss()
    popup = await openNativePopup(worker, profile, extensionId)
    await popup.waitButton('Review in Palladin'); await popup.click('Review in Palladin')
    await wait(() => popup.secretCaptureFieldsMatch({ 'input[autocomplete="cc-name"]': 'Synthetic two' }), 'second form review fields')
    await popup.click('Dismiss'); assert.equal(api.writes.length, count)
  })
  await run('multiple API results remain separate explicit choices', async () => {
    await visit('multiple', 15)
    const count = api.writes.length
    await openReview(); assert(await popup.secretCaptureFieldsMatch({ 'input[type="password"]': key(15) }))
    await popup.click('Dismiss'); await popup.dismiss()
    popup = await openNativePopup(worker, profile, extensionId)
    await popup.waitButton('Review in Palladin'); await popup.click('Review in Palladin')
    await wait(() => popup.secretCaptureFieldsMatch({ 'input[type="password"]': key(16) }), 'second key review fields')
    await popup.click('Dismiss'); assert.equal(api.writes.length, count)
  })
  await run('unrelated tab/frame navigation preserves edits; own source navigation immediately invalidates before save', async () => {
    const unrelated = await context.newPage()
    await unrelated.goto('https://unrelated.example.test/blank')
    await visit('card-with-frame', 10)
    await page.locator('[autocomplete="cc-number"]').fill(pan); await pause(600)
    await openReview()
    const count = api.writes.length
    await popup.fill('.entry-form > label input', 'Unsaved capture name', { replace: true })
    await popup.fill('input[autocomplete="cc-name"]', 'Unsaved Cardholder')
    await popup.fill('input[autocomplete="cc-exp-month"]', '11')
    await popup.fill('input[autocomplete="cc-exp-year"]', '2034')
    await popup.fill('input[type="password"][maxlength="4"]', cvv)
    await popup.select('.capture-prompt > label select', api.vaults[1].detail.id)
    const edits = { '.entry-form > label input': 'Unsaved capture name', 'input[autocomplete="cc-name"]': 'Unsaved Cardholder',
      'input[autocomplete="cc-exp-month"]': '11', 'input[autocomplete="cc-exp-year"]': '2034',
      'input[type="password"][maxlength="4"]': cvv, '> label select': api.vaults[1].detail.id }
    for (const [selector, value] of Object.entries(edits)) assert(await popup.secretCaptureFieldsMatch({ [selector]: value }), `Native edit applied before navigation: ${selector}`)
    assert(await worker.evaluate(url => chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]?.id === globalThis.secretCaptureTabs[url]), page.url()), 'Source tab remains active')
    try {
      await unrelated.goto('https://unrelated.example.test/blank?next')
      await pause(600)
      assert(await popup.secretCaptureFieldsMatch(edits), 'Unrelated background-tab navigation preserves the entire native draft')
      await page.frames().find(frame => frame.url().startsWith('https://unrelated-frame.example.test/')).goto('https://unrelated-frame.example.test/blank?next')
      await pause(600)
      assert(await popup.secretCaptureFieldsMatch(edits), 'Unrelated frame disconnect preserves the entire native draft')
    } finally { await unrelated.close() }
    await page.goto('https://navigation.example.test/blank')
    await wait(async () => !(await popup.hasText('Save captured item')), 'editor removed on navigation', 1_500)
    assert.equal(await popup.hasButton('Save entry'), false)
    assert.equal(api.writes.length, count)
  })
  await run('manual lock removes native plaintext editor and ignores locked observations', async () => {
    await visit('readonly', 11); await openReview()
    const count = api.writes.length
    await popup.click('Lock'); await popup.waitButton('Unlock')
    assert.equal(await popup.hasButton('Save entry'), false)
    await popup.dismiss(); popup = null
    await visit('generated', 12); await page.getByRole('button', { name: '生成 🔑' }).click(); await pause(900)
    await wait(noticeButton, 'value-free locked guidance')
    popup = await openNativePopup(worker, profile, extensionId)
    await popup.fill('input[type="password"]', api.password); await popup.click('Unlock'); await popup.waitText('Personal')
    assert.equal(await popup.hasText('Save captured item'), false, 'Locked generation retained nothing')
    assert.equal(api.writes.length, count)
  })
  await run('Polish notice and popup translation use established UI preferences', async () => {
    await worker.evaluate(() => chrome.storage.local.set({ 'palladin.ui.preferences': { language: 'pl', theme: 'dark' } }))
    await visit('generated', 13); await page.getByRole('button', { name: '生成 🔑' }).click()
    await wait(noticeButton, 'Polish notice')
    popup = await openNativePopup(worker, profile, extensionId)
    await popup.waitButton('Sprawdź w Palladin')
    assert.equal(api.writes.some(write => JSON.stringify(write.request).includes(key(13))), false)
  })
  popup = await openNativePopup(worker, profile, extensionId)
  const allKeys = Array.from({ length: 18 }, (_, i) => key(i + 1))
  assert(await popup.webStorageExcludes([...testedSecrets, ...allKeys]), 'Native local/session web storage excludes synthetic plaintext')
  const persisted = JSON.stringify(await worker.evaluate(async () => {
    const stores = []
    for (const info of await indexedDB.databases()) {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open(info.name); request.onsuccess = () => resolve(request.result); request.onerror = reject })
      for (const name of db.objectStoreNames) stores.push(await new Promise((resolve, reject) => {
        const request = db.transaction(name, 'readonly').objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = reject
      }))
      db.close()
    }
    return [await chrome.storage.local.get(null), await chrome.storage.session.get(null), await chrome.storage.sync.get(null), stores]
  }))
  const vaultKeys = api.vaults.flatMap(vault => [Buffer.from(vault.vaultKey).toString('base64'), Buffer.from(vault.vaultKey).toString('base64url'), JSON.stringify([...vault.vaultKey])])
  assert([...testedSecrets, ...allKeys, ...vaultKeys].every(value => !persisted.includes(value)), 'Synthetic secrets absent from persisted extension stores')
  assert.deepEqual(api.errors, [])
  console.log(`PASS: persistence contains no tested synthetic secret material; ${api.writes.length} encrypted writes`)
  assert.equal(failures.length, 0, `Failed cases: ${failures.join('; ')}`)
} finally {
  popup?.close(); await context?.close(); await api.close(); await rm(profile, { recursive: true, force: true })
}

function fixture(url) {
  const kind = url.pathname.slice(1), index = Number(url.searchParams.get('case') ?? 0)
  const html = body => `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px system-ui;padding:32px}input{display:block;margin:12px;padding:8px}section{padding:12px}iframe{width:600px;height:420px}</style></head><body>${body}</body></html>`
  const number = '<input id="number" aria-label="番号" autocomplete="cc-number">'
  if (kind === 'blank') return html('<h1>Neutral destination</h1>')
  if (kind === 'frame') return html(`<h1>お支払い</h1>${number}<aside><input autocomplete="cc-name" value="Unrelated document person"><input autocomplete="cc-exp-month" value="09"><input autocomplete="cc-exp-year" value="2099"></aside>`)
  if (kind === 'iframe') return html(`<h1>Payment host</h1><iframe src="https://payment.example.test/frame"></iframe>`)
  if (kind === 'card') return html(`<h1>Płatność</h1><form>${number}<input autocomplete="cc-name" aria-label="Właściciel"><input autocomplete="cc-exp-month" aria-label="Miesiąc"><input autocomplete="cc-exp-year" aria-label="Rok"><input autocomplete="cc-csc" aria-label="Kod"></form>`)
  if (kind === 'card-with-frame') return html(`<h1>Płatność</h1><form>${number}</form><iframe src="https://unrelated-frame.example.test/blank"></iframe>`)
  if (kind === 'external') return html(`<h1>External form controls</h1><form id="payment"></form><section><input form="payment" autocomplete="cc-number"><input autocomplete="cc-name" value="Unrelated sibling"><input autocomplete="cc-exp" value="09/2099"></section><aside><input form="payment" autocomplete="cc-name" value="Synthetic External"><select form="payment" autocomplete="cc-exp-year" size="2"><option value="" selected>Year</option><option value="2031">2031</option></select></aside><select form="payment" autocomplete="cc-exp-month" size="2"><option value="" selected>Month</option><option value="12">12</option></select>`)
  if (kind === 'two-forms') return html(`<h1>Two payments</h1>${['one','two'].map(id => `<form id="${id}">${number}<input autocomplete="cc-name"></form>`).join('')}`)
  if (kind === 'multiple') return html(`<section><h1>API keys</h1><input readonly value="${key(index)}"><input readonly value="${key(index + 1)}"></section>`)
  if (kind === 'structural') return html('<h1>支払い</h1><section><input id="number" aria-label="番号"><input type="month" aria-label="有効期限"></section>')
  if (kind === 'negative') return html(`<h1>Samples</h1><form>${number}</form><section hidden><p>API key generated</p><output>${key(8)}</output></section><svg style="display:none"><text>API key generated ${key(8)}</text></svg><section><h2>Documentation sample API key</h2><code>${key(8)}</code></section>`)
  if (kind === 'readonly') return html(`<section><h1>API key</h1><input readonly value="${key(index)}"></section>`)
  const result = `<section><h1>生成された資格情報 · مفتاح · klucz</h1><button type="button">生成 🔑</button><div id="result"></div></section>`
  if (kind === 'shadow') return html(`<div id="host"></div><script>const root=document.querySelector('#host').attachShadow({mode:'open'});root.innerHTML=${JSON.stringify(result)};root.querySelector('button').onclick=()=>{root.querySelector('#result').innerHTML='<output>${key(index)}</output>'}</script>`)
  const tag = kind === 'replacement' ? 'input readonly' : 'output'
  const output = kind === 'replacement' ? `<${tag} value="${key(index)}">` : `<output>${key(index)}</output>`
  return html(`${result}<script>document.querySelector('button').onclick=()=>{document.querySelector('#result').outerHTML=${JSON.stringify(`<div id="result">${output}</div>`)}}</script>`)
}
