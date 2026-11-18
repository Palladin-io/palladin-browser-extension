/** Reload invalidates existing isolated worlds; a worker restart does not. */
export async function restoreContentScripts(activeTabOnly = false): Promise<void> {
  const files = chrome.runtime.getManifest().content_scripts
    ?.filter(script => !('world' in script) || script.world !== 'MAIN')
    .flatMap(script => script.js ?? []) ?? [];
  if (files.length === 0) return;
  const tabs = await chrome.tabs.query({ url: ['https://*/*'], ...(activeTabOnly ? { active: true, currentWindow: true } : {}) });
  await Promise.allSettled(tabs.filter(tab => tab.id !== undefined).map(tab =>
    chrome.scripting.executeScript({
      target: { tabId: tab.id!, frameIds: [0] },
      world: 'ISOLATED',
      files,
    }),
  ));
}
