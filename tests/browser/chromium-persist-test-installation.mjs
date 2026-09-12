import assert from 'node:assert/strict'

// Run only on the harness's fresh profile, before it creates an account. Chrome/Edge
// removes a CDP-only installation on restart. Its ordinary Extensions-page
// Reload action uses the normal unpacked installer instead. The later restart
// must independently observe the persisted installation; it never calls this
// helper again. No profile preferences or extension storage are edited here.
export async function persistChromiumTestInstallation(context, extensionId, browserLabel = 'chrome') {
  assert(['chrome', 'edge'].includes(browserLabel), 'Tested browser UI adapter required')
  assert(/^[a-p]{32}$/.test(extensionId), 'Exact browser-installed Chromium ID required')
  const browserCdp = await context.browser().newBrowserCDPSession()
  const page = await context.newPage()
  try {
    const installed = (await browserCdp.send('Extensions.getExtensions')).extensions.find(value => value.id === extensionId)
    assert(installed?.enabled, 'The exact test artifact must already be installed by the browser')
    await page.goto(`${browserLabel}://extensions`)
    let reload
    if (browserLabel === 'chrome') {
      const toggle = page.locator('extensions-toolbar #devMode')
      await toggle.waitFor()
      if (!await toggle.evaluate(element => element.checked)) await toggle.click()
      const card = page.locator('extensions-item#' + extensionId)
      await card.waitFor()
      reload = card.getByRole('button', { name: 'Reload', exact: true })
    } else {
      // Edge's browser-owned WebUI uses nested custom elements. Its card data
      // comes from the browser registry, never from product/page claims. Only
      // read the exact ID; do not mutate the card or call its internal methods.
      const handle = await page.waitForFunction(id => {
        const walk = root => Array.from(root.querySelectorAll('*')).flatMap(element =>
          [element, ...(element.shadowRoot ? walk(element.shadowRoot) : [])])
        const cards = walk(document).filter(element => element.tagName === 'EXTENSION-CARD' && element._data?.id === id)
        if (cards.length !== 1) return null
        const buttons = walk(cards[0].shadowRoot ?? cards[0]).filter(element =>
          element.tagName === 'FLUENT-BUTTON' && element.textContent.trim() === 'Reload')
        return buttons.length === 1 ? buttons[0] : null
      }, extensionId, { timeout: 10000 })
      reload = handle.asElement()
      assert(reload, 'Expected the exact browser-owned Edge card reload button')
    }
    const ownWorker = target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`)
    const before = (await browserCdp.send('Target.getTargets')).targetInfos.filter(ownWorker).map(target => target.targetId)
    assert.equal(before.length, 1, 'Expected one own worker before the browser UI reload')
    await reload.click({ timeout: 10000 })
    let replaced = false
    for (let attempt = 0; attempt < 100 && !replaced; attempt++) {
      const targets = (await browserCdp.send('Target.getTargets')).targetInfos
      replaced = !targets.some(target => before.includes(target.targetId)) && targets.some(ownWorker)
      if (!replaced) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert(replaced, 'The browser UI must actually replace the initial worker before any account is created')
  } finally {
    await page.close()
    await browserCdp.detach()
  }
}
