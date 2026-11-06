/** Browser action popups can become the current window without owning any tabs. */
export async function activePageTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (window.id === undefined) return null;
    const tabs = await chrome.tabs.query({ active: true, windowId: window.id });
    const current = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const tab = tabs[0];
    return current.id === window.id && tab?.windowId === window.id && !tab.incognito ? tab : null;
  } catch { return null; }
}
