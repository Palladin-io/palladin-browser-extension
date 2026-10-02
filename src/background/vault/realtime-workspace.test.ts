import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => void>(), start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }));
vi.mock('@microsoft/signalr', () => ({ HubConnectionState: { Disconnected: 'Disconnected' }, LogLevel: { None: 6 }, HubConnectionBuilder: class {
  withUrl() { return this; }
  withAutomaticReconnect() { return this; }
  configureLogging() { return this; }
  build() { return { on: (name: string, callback: (...args: unknown[]) => void) => fixture.handlers.set(name, callback), onreconnecting() {}, onreconnected() {}, onclose() {}, start: fixture.start, stop: fixture.stop }; }
} }));
import { VaultRealtimeConnection } from './realtime-sync';

it('forwards only a value-free notification invalidation and suppresses late events after lock', async () => {
  const workspaceChanged = vi.fn();
  const connection = new VaultRealtimeConnection({ apiUrl: () => 'https://example.test', accessToken: async () => 'synthetic-token', invalidation: vi.fn(), repair: vi.fn(), workspaceChanged });
  connection.start();
  await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledOnce());
  fixture.handlers.get('ReceiveNotification')?.('GrantRequested', { reason: 'synthetic-private-text' });
  expect(workspaceChanged).toHaveBeenCalledWith();
  expect(workspaceChanged).toHaveBeenCalledOnce();
  connection.stop();
  fixture.handlers.get('ReceiveNotification')?.('GrantRequested', { reason: 'late-synthetic-text' });
  expect(workspaceChanged).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalledOnce());
});
