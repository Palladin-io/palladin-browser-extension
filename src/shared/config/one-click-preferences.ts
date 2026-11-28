export const ONE_CLICK_MUTED_KEY = 'palladin.one-click.muted-hosts.v1';
export const ONE_CLICK_DISABLED_KEY = 'palladin.one-click.disabled.v1';
export const MAX_ONE_CLICK_MUTED = 500;

export function parseMutedHosts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
