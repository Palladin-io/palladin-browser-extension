import { INBOX_SEEN_MESSAGE } from '../../background/inbox-attention';

export function markInboxSeen(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  void Promise.resolve(chrome.runtime.sendMessage({ type: INBOX_SEEN_MESSAGE })).catch(() => undefined);
}
