import assert from 'node:assert/strict'

// Run only on the harness's fresh profile, before it creates an account. Chrome
// removes a CDP-only installation on restart. Its ordinary Extensions-page
// Reload action uses the normal unpacked installer instead. The later restart
// must independently observe the persisted installation; it never calls this
// helper again. No profile preferences or extension storage are edited here.
export async function persistChromeTestInstallation(context, extensionId) {
  assert(/^[a-p]{32}$/.test(extensionId), 'Exact browser-installed Chromium ID required')
  const browserCdp = await context.browser().newBrowserCDPSession()
  const page = await context.newPage()
  try {
    const installed = (await browserCdp.send('Extensions.getExtensions')).extensions.find(value => value.id === extensionId)
    assert(installed?.enabled, 'The exact test artifact must already be installed by Chrome')
    await page.goto('chrome://extensions')
    const toggle = page.locator('extensions-toolbar #devMode')
    await toggle.waitFor()
    if (!await toggle.evaluate(element => element.checked)) await toggle.click()
    const card = page.locator('extensions-item#' + extensionId)
    await card.waitFor()
    const ownWorker = target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`)
    const before = (await browserCdp.send('Target.getTargets')).targetInfos.filter(ownWorker).map(target => target.targetId)
    assert.equal(before.length, 1, 'Expected one own worker before the browser UI reload')
    await card.getByRole('button', { name: 'Reload', exact: true }).click({ timeout: 10000 })
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
