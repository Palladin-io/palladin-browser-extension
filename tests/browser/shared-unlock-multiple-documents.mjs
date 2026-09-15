import assert from 'node:assert/strict'
import { waitForWebEntryPassword } from './native-web-entry.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// Same browser profile, independent Web documents, real keys/Identity/Entry.
// A late document must respect a manual lock rather than revive an old root.
export async function verifyMultipleWebDocuments({ page, popup, reopenPopup,
  webOrigin, password, vaultId, entryId, entryPassword, setStage, recordCheck }) {
  const peers = []
  const entryUrl = `${webOrigin}/vaults/${vaultId}/entries/${entryId}`
  const assertLocked = async documents => {
    for (const document of documents) {
      assert(await document.locator('#unlock-password').isVisible(), 'Every same-account Web document must stay locked')
      assert.equal(await document.locator('#entry-detail-password').count(), 0,
        'A locked document must remove its decrypted Entry form')
    }
    assert(await popup.revealDeniedWhileLocked(vaultId, entryId), 'Locked extension must deny actual Entry decryption')
  }
  const waitAllUnlocked = async documents => {
    for (const document of documents) await waitForWebEntryPassword(document, entryPassword)
    await popup.waitText('Unlocked')
    assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword))
  }
  try {
    setStage('multiple-web-documents-automatic-unlock')
    await page.goto(entryUrl)
    await waitForWebEntryPassword(page, entryPassword)
    for (let index = 0; index < 2; index++) {
      const peer = await page.context().newPage()
      peers.push(peer)
      await peer.goto(entryUrl)
      await waitForWebEntryPassword(peer, entryPassword)
    }
    popup = await reopenPopup()
    await waitAllUnlocked([page, ...peers])
    recordCheck('three-web-documents-automatically-unlock-and-decrypt-own-entry')

    setStage('multiple-web-documents-secondary-tab-manual-lock')
    await peers[1].getByRole('button', { name: 'Lock', exact: true }).click()
    for (const document of [page, ...peers]) await document.locator('#unlock-password').waitFor()
    await popup.waitButton('Unlock')
    await assertLocked([page, ...peers])
    recordCheck('manual-lock-in-secondary-tab-closes-all-web-documents-and-extension')

    setStage('multiple-web-documents-late-tab-cannot-reverse-lock')
    const late = await page.context().newPage()
    peers.push(late)
    await late.goto(entryUrl)
    await late.locator('#unlock-password').waitFor()
    popup = await reopenPopup()
    const until = Date.now() + 16_000
    while (Date.now() < until) {
      await assertLocked([page, ...peers])
      await pause(1000)
    }
    recordCheck('late-fourth-web-document-cannot-reverse-manual-lock-through-repair')

    setStage('multiple-web-documents-one-fresh-unlock-restores-all')
    await late.locator('#unlock-password').fill(password)
    await late.getByRole('button', { name: 'Unlock', exact: true }).click()
    await waitAllUnlocked([late, page, ...peers.slice(0, 2)])
    recordCheck('one-manual-unlock-restores-four-web-documents-and-extension-entry-access')

    setStage('multiple-web-documents-source-close-preserves-peers')
    await late.close()
    peers.pop()
    popup = await reopenPopup()
    await waitAllUnlocked([page, ...peers])
    recordCheck('closing-manual-source-tab-preserves-other-web-documents-and-extension')

    setStage('multiple-web-documents-extension-lock-reaches-all-tabs')
    await popup.click('Lock')
    for (const document of [page, ...peers]) await document.locator('#unlock-password').waitFor()
    await popup.waitButton('Unlock')
    await assertLocked([page, ...peers])
    recordCheck('extension-manual-lock-closes-all-live-web-documents')
    await page.locator('#unlock-password').fill(password)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await waitAllUnlocked([page, ...peers])
  } finally {
    for (const peer of peers) await peer.close().catch(() => {})
  }
  // Only reopen after successful completion; cleanup must not hide a prior
  // product failure behind a second popup error.
  await reopenPopup()
}
