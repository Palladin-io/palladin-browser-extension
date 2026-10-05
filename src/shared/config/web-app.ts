const DEFAULT_WEB_APP_URL = "http://localhost:5173";

type EnvSource = Record<string, string | undefined>;

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function resolveWebAppUrl(source: EnvSource): string {
  const configured = source["VITE_WEB_APP_URL"];
  return trimTrailingSlash(configured && configured.length > 0 ? configured : DEFAULT_WEB_APP_URL);
}

export const webAppUrl: string = resolveWebAppUrl(
  import.meta.env as unknown as EnvSource,
);

/** Read the active public connection at the time of the user action. */
export async function configuredPanelUrl(path = ''): Promise<string> {
  const result: import('../../background/config/connection-commands').ConnectionResult = await chrome.runtime.sendMessage({ type: 'config/connections/get' });
  if (!result?.ok) throw new Error('Panel configuration unavailable');
  const selected = result.state.connections.find(item => item.apiUrl === result.state.activeApiUrl);
  const base = selected?.webUrl ?? webAppUrl;
  return `${base}${path}`;
}
