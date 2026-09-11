// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { I18nProvider, type Locale } from './i18n';
import type { SessionClient } from './session/client';
import { SharedUnlockCompletionNotice } from '../background/shared-unlock/completion-notice';
import { SHARED_UNLOCK_NOTICE_PORT } from '../shared/messaging/shared-unlock-notice';
import { sessionChanged } from '../shared/messaging';

const id = 'a'.repeat(32), origin = `chrome-extension://${id}/`;
function event<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return { addListener: (fn: T) => { listeners.add(fn); }, removeListener: (fn: T) => { listeners.delete(fn); }, listeners };
}
function setup(locale: Locale = 'en') {
  const notices = new SharedUnlockCompletionNotice();
  const onMessage = event<(raw: unknown) => void>();
  const ports: { receive: (raw: unknown) => void; close: () => void }[] = [];
  let surface: 'popup' | 'side-panel' = 'popup';
  const runtime = { id, onMessage, sendMessage: vi.fn(async () => ({ ok: false, code: 'unavailable' })),
    connect: vi.fn(({ name }: { name: string }) => {
      const workerMessages = event<(raw: unknown) => void>(), clientMessages = event<(raw: unknown) => void>();
      const workerDisconnect = event<() => void>(), clientDisconnect = event<() => void>();
      const close = () => { for (const fn of workerDisconnect.listeners) fn(); for (const fn of clientDisconnect.listeners) fn(); };
      const receive = (raw: unknown) => { for (const fn of clientMessages.listeners) fn(raw); };
      const worker = { name, sender: { id, url: `${origin}src/${surface}/index.html` }, onMessage: workerMessages,
        onDisconnect: workerDisconnect, postMessage: receive, disconnect: close };
      if (name === SHARED_UNLOCK_NOTICE_PORT) { notices.register(worker, id, origin); ports.push({ receive, close }); }
      return { onMessage: clientMessages, onDisconnect: clientDisconnect,
        postMessage: (raw: unknown) => { for (const fn of workerMessages.listeners) fn(raw); }, disconnect: close };
    }) };
  vi.stubGlobal('chrome', { runtime, tabs: { onActivated: event<() => void>(), onUpdated: event<() => void>() } });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const client: SessionClient = {
    getStatus: async () => 'locked', getCapabilities: async () => ({ runtimeUnlock: false }),
    login: async () => ({ status: 'unlocked' }), completeTotp: async () => 'unlocked', cancelTotp: async () => {},
    unlock: async () => 'unlocked', lock: async () => {}, logout: async () => {},
  };
  const mount = (target: typeof surface) => {
    surface = target;
    return render(<I18nProvider locale={locale}><App surface={target} client={client}
      onboardingClient={{ getStatus: async () => 'completed', complete: async () => {}, openPasswordSettings: async () => {}, openExtensionManager: async () => {} }}
    /></I18nProvider>);
  };
  const unlocked = () => { for (const fn of onMessage.listeners) fn(sessionChanged('unlocked')); };
  return { notices, ports, mount, unlocked, onMessage };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Popup and Side Panel consume one worker-owned completion', () => {
  it.each([
    ['en', 'Extension unlocked by the Palladin panel.'],
    ['pl', 'Rozszerzenie odblokowane przez panel Palladin.'],
  ] as const)('shows one %s polite message across both real hosts without focus or replay', async (locale, message) => {
    const f = setup(locale), popup = f.mount('popup'), panel = f.mount('side-panel');
    await waitFor(() => expect(screen.getAllByRole('heading')).toHaveLength(2));
    const focusTarget = document.createElement('button'); document.body.append(focusTarget); focusTarget.focus();
    act(() => { f.unlocked(); f.notices.completed(); });
    expect(await screen.findAllByText(message)).toHaveLength(1);
    expect(screen.getByText(message)).toHaveAttribute('aria-live', 'polite');
    expect(focusTarget).toHaveFocus();
    expect(screen.getByText(message).outerHTML).not.toContain(id);
    popup.unmount();
    f.mount('popup');
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    act(() => { f.unlocked(); f.notices.completed(); });
    expect(await screen.findAllByText(message)).toHaveLength(1);
    expect(panel.container).toContainElement(screen.getByText(message));
    focusTarget.remove();
  });
  it('drops hidden and delayed delivery and never replays it on visibility or remount', async () => {
    const f = setup(); f.mount('popup');
    await screen.findByRole('heading');
    act(f.unlocked);
    act(() => f.ports[0].receive({ type: 'completed', occurredAt: Date.now() - 2000 }));
    expect(screen.queryByText('Extension unlocked by the Palladin panel.')).not.toBeInTheDocument();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => f.ports[0].receive({ type: 'completed', occurredAt: Date.now() }));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.queryByText('Extension unlocked by the Palladin panel.')).not.toBeInTheDocument();
  });
  it('clears on worker lock and disconnect, reconnecting without replay or activity', async () => {
    const f = setup(); f.mount('popup'); await screen.findByRole('heading');
    act(() => { f.unlocked(); f.notices.completed(); });
    expect(await screen.findByText('Extension unlocked by the Palladin panel.')).toBeInTheDocument();
    act(() => f.notices.clear());
    expect(screen.queryByText('Extension unlocked by the Palladin panel.')).not.toBeInTheDocument();
    vi.useFakeTimers();
    act(() => f.ports[0].close());
    act(() => vi.advanceTimersByTime(1000));
    expect(f.ports).toHaveLength(2);
    expect(screen.queryByText('Extension unlocked by the Palladin panel.')).not.toBeInTheDocument();
    act(() => f.notices.completed());
    expect(screen.getByText('Extension unlocked by the Palladin panel.')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByText('Extension unlocked by the Palladin panel.')).not.toBeInTheDocument();
  });
  it('does not reconnect an invalidated extension page', async () => {
    const f = setup(); f.mount('popup'); await screen.findByRole('heading');
    vi.useFakeTimers();
    Object.defineProperty(chrome.runtime, 'id', { get: () => { throw new Error('Extension context invalidated'); } });
    expect(() => act(() => f.ports[0].close())).not.toThrow();
    act(() => vi.advanceTimersByTime(1000));
    expect(f.ports).toHaveLength(1);
  });
});
