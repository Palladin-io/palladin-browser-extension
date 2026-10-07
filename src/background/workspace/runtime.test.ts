import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: { apiUrl: 'https://api.example.test', activeConnection: undefined as { webUrl: string } | undefined },
  actions: null as null | { webUrl(): string },
}));
vi.mock('../vault/runtime', () => ({ vaultData: {} }));
vi.mock('../../shared/config/web-app', () => ({ webAppUrl: 'https://panel.example.test' }));
vi.mock('../config/env', () => ({ env: { apiUrl: 'https://api.example.test' } }));
vi.mock('../config/server-runtime', () => ({ serverConfig: state.config }));
vi.mock('../vault/protocol2/client', () => ({ Protocol2VaultClient: class {} }));
vi.mock('./entry-actions', () => ({ EntryActions: class {
  constructor(deps: { webUrl(): string }) { state.actions = deps; }
} }));
vi.mock('../session/runtime', () => ({ sessionManager: { hooks: { onLocked: vi.fn() } } }));
vi.mock('./service', async importOriginal => {
  const actual = await importOriginal<typeof import('./service')>();
  return { ...actual, WorkspaceService: class {} };
});
import './runtime';

describe('workspace share panel connection', () => {
  beforeEach(() => {
    state.config.apiUrl = 'https://api.example.test';
    state.config.activeConnection = undefined;
  });
  it('uses the packaged panel only with its packaged API', () => {
    expect(state.actions!.webUrl()).toBe('https://panel.example.test');
  });
  it('uses the selected panel and observes connection changes', () => {
    state.config.apiUrl = 'https://custom-api.example.test';
    state.config.activeConnection = { webUrl: 'https://custom-panel.example.test' };
    expect(state.actions!.webUrl()).toBe('https://custom-panel.example.test');
    state.config.activeConnection = { webUrl: 'https://other-panel.example.test' };
    expect(state.actions!.webUrl()).toBe('https://other-panel.example.test');
  });
  it('rejects a legacy custom API without an explicitly paired panel', () => {
    state.config.apiUrl = 'https://custom-api.example.test';
    expect(() => state.actions!.webUrl()).toThrow();
  });
});
