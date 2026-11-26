import { expect, it, vi } from 'vitest';
import { InboxAttention, inboxBadgeText, isInboxSeenMessage } from './inbox-attention';

function setup(pending: () => Promise<number | null> = async () => 0) {
  const action = { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() };
  const attention = new InboxAttention({ action, pendingGrants: pending });
  const text = () => action.setBadgeText.mock.calls.at(-1)?.[0].text;
  return { attention, text };
}

it('counts realtime notifications while unlocked and clears them when the Inbox is seen', async () => {
  const { attention, text } = setup();
  await attention.unlocked();
  attention.notified();
  attention.notified();
  expect(text()).toBe('2');
  attention.seen();
  expect(text()).toBe('');
});

it('surfaces grants already waiting for a decision after unlock', async () => {
  const { attention, text } = setup(async () => 3);
  await attention.unlocked();
  expect(text()).toBe('3');
});

it('ignores notifications and a late pending count after lock', async () => {
  let resolve!: (value: number) => void;
  const { attention, text } = setup(() => new Promise(r => { resolve = r; }));
  const unlocking = attention.unlocked();
  attention.locked();
  resolve(5);
  await unlocking;
  attention.notified();
  expect(text()).toBe('');
});

it('caps the badge and accepts only the exact seen message', () => {
  expect(inboxBadgeText(120)).toBe('99+');
  expect(isInboxSeenMessage({ type: 'workspace/inbox-seen' })).toBe(true);
  expect(isInboxSeenMessage({ type: 'workspace/inbox-seen', count: 0 })).toBe(false);
  expect(isInboxSeenMessage('workspace/inbox-seen')).toBe(false);
});

it('does not let a late unlock seed restore the badge after the Inbox was opened', async () => {
  let resolve!: (value: number) => void;
  const { attention, text } = setup(() => new Promise(r => { resolve = r; }));
  const unlocking = attention.unlocked();
  attention.seen();
  resolve(4);
  await unlocking;
  expect(text()).toBe('');
  attention.notified();
  expect(text()).toBe('1');
});
