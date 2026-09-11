/** Read only after the actual Entry form finishes asynchronous decryption.
 * The expected synthetic value stays in memory and never enters diagnostics. */
export async function waitForWebEntryPassword(page, expected) {
  await page.locator('#entry-detail-password').waitFor()
  const matched = await page.waitForFunction(value => {
    const field = document.getElementById('entry-detail-password')
    return field instanceof HTMLInputElement && !field.disabled && field.value === value
  }, expected, { polling: 100 })
  await matched.dispose()
}
