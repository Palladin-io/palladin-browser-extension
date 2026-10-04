import { expect, it, vi } from 'vitest';
import { handleNativeAgentMessage, type AgentFillDeps, type AgentProviderSession } from './native-provider';
import type { AgentInjectForm } from '@shared/messaging';
const top = { id: 7, page: { url: 'https://appstoreconnect.apple.com/login', documentId: 'top' } };
const child = { id: 7, page: { url: 'https://idmsa.apple.com/appleauth/auth/signin', documentId: 'child' } };
const form: AgentInjectForm = { version: 2, steps: [{ fields: [{ entryFieldId: 'credential.username', control: 'username', selector: `palladin-live:${'a'.repeat(32)}:${'b'.repeat(32)}` }], submit: { action: 'deferred-native-click', selector: `palladin-live:${'a'.repeat(32)}:${'c'.repeat(32)}` } }] };
it('returns the selected credential document URL while retaining the caller-selected outer tab binding', async () => {
  const scoped: AgentFillDeps = { getActivePage: async () => child, getPageById: async () => child, sendStep: async () => null, probeTransition: async () => null };
  const deps = { ...scoped, getActivePage: async () => top, getPageById: async () => top,
    inspectLiveLogin: async () => null, prepareFrame: vi.fn(async () => ({ page: child, form, deps: scoped })) };
  const session: AgentProviderSession = { prepared: null };
  const result = await handleNativeAgentMessage(deps, { consume: async () => true }, session,
    { protocol: 'palladin.inject-provider.v1', type: 'prepare', nonce: 'a'.repeat(64), targetTabId: 7, targetUrl: top.page.url, liveDetection: true });
  expect(result).toMatchObject({ outcome: 'ready', currentUrl: child.page.url, liveForm: form });
});
