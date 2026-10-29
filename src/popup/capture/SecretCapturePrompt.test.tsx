import type { SecretCapturePopupCommand } from '@shared/messaging/secret-capture';
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SecretCapturePrompt } from './SecretCapturePrompt';
import type { SecretCaptureResult } from '../../background/capture/secret-coordinator';
import type { VaultClient } from '../vault/client';
const card: SecretCaptureResult = { status: 'review', id: 'capture', origin: 'https://processor.test', candidate: { kind: 'card', cardNumber: '4111111111111111', cardholderName: '', expiryMonth: '', expiryYear: '' }, vaults: [{ id: 'v', name: 'Personal', isDefault: true }, { id: 'team', name: 'Team', isDefault: false }] };
it.each(['review', 'failure'])('preserves unrelated editor edits and fences a late preview %s, then immediately removes the affected editor', async response => {
  const { useSecretCapture } = await import('./SecretCapturePrompt');
  const listeners = new Set<(event: unknown) => void>();
  let release!: (result: SecretCaptureResult) => void; let reject!: (error: Error) => void; let requests = 0;
  vi.stubGlobal('chrome', { runtime: {
    sendMessage: async (command: SecretCapturePopupCommand) => command.type === 'begin-review' || ++requests === 1 ? card : new Promise<SecretCaptureResult>((resolve, fail) => { release = resolve; reject = fail; }),
    onMessage: { addListener: (listener: (event: unknown) => void) => listeners.add(listener), removeListener: (listener: (event: unknown) => void) => listeners.delete(listener) },
  } });
  function Surface() {
    const [review, done] = useSecretCapture(0);
    return review ? <SecretCapturePrompt key={review.id} review={review} client={{} as VaultClient} onDone={done} /> : null;
  }
  try {
    render(<Surface />); fireEvent.click(await screen.findByRole('button', { name: 'Review in Palladin' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Unsaved name' } });
    fireEvent.change(screen.getByLabelText('Cardholder name'), { target: { value: 'Unsaved holder' } });
    fireEvent.change(screen.getByLabelText('Expiry month'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Expiry year'), { target: { value: '2031' } });
    fireEvent.change(screen.getByLabelText('CVV / CVC'), { target: { value: '739' } });
    fireEvent.change(screen.getByLabelText('Destination Vault'), { target: { value: 'team' } });
    await act(async () => { for (const listener of listeners) listener({ type: 'secret-capture/available' }); });
    act(() => { for (const listener of listeners) listener({ type: 'secret-capture/invalidated', candidateIds: ['other-capture'] }); });
    await act(async () => response === 'review' ? release({ ...card, id: 'other-capture' }) : reject(Error('Source invalidated')));
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved name');
    expect(screen.getByLabelText('Cardholder name')).toHaveValue('Unsaved holder');
    expect(screen.getByLabelText('Expiry month')).toHaveValue('12');
    expect(screen.getByLabelText('Expiry year')).toHaveValue('2031');
    expect(screen.getByLabelText('CVV / CVC')).toHaveValue('739');
    expect(screen.getByLabelText('Destination Vault')).toHaveValue('team');
    act(() => { for (const listener of listeners) listener({ type: 'secret-capture/invalidated', candidateIds: [card.id] }); });
    expect(screen.queryByLabelText('Card number')).not.toBeInTheDocument();
  } finally { vi.unstubAllGlobals(); }
});

it.each([{ candidateIds: undefined }, { candidateIds: ['capture'] }, { candidateIds: ['unrelated'] }])('applies deferred begin-review only when invalidation $candidateIds excludes the selected ID', async ({ candidateIds }) => {
  const listeners = new Set<(event: unknown) => void>();
  let release!: (result: SecretCaptureResult) => void;
  const send = () => new Promise<SecretCaptureResult>(resolve => { release = resolve; });
  vi.stubGlobal('chrome', { runtime: {
    onMessage: { addListener: (listener: (event: unknown) => void) => listeners.add(listener), removeListener: (listener: (event: unknown) => void) => listeners.delete(listener) },
  } });
  try {
    render(<SecretCapturePrompt review={card} client={{} as VaultClient} send={send} onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review in Palladin' }));
    act(() => { for (const listener of listeners) listener({ type: 'secret-capture/invalidated', ...(candidateIds ? { candidateIds } : {}) }); });
    await act(async () => release({ ...card, candidate: { kind: 'card', cardNumber: '4111111111111111', cardholderName: 'Latest selected holder', expiryMonth: '12', expiryYear: '2031' } }));
    if (candidateIds?.[0] === 'unrelated') {
      expect(screen.getByLabelText('Cardholder name')).toHaveValue('Latest selected holder');
      expect(screen.getByLabelText('Expiry month')).toHaveValue('12');
      expect(screen.queryByRole('button', { name: 'Review in Palladin' })).not.toBeInTheDocument();
    } else expect(screen.queryByLabelText('Card number')).not.toBeInTheDocument();
  } finally { vi.unstubAllGlobals(); }
});
describe('trusted secret capture editor', () => {
  it('requires review, shows destination and lets the user complete missing fields without CVV', async () => {
    const send = vi.fn(async (command: SecretCapturePopupCommand) => command.type === 'begin-review' ? card : ({ status: 'saved' } as const));
    render(<SecretCapturePrompt review={card} client={{} as VaultClient} send={send} onDone={() => {}} />);
    expect(screen.queryByLabelText('Card number')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review in Palladin' }));
    expect(await screen.findByLabelText('Destination Vault')).toHaveValue('v');
    expect(screen.getByLabelText('Card number')).toHaveAttribute('type','password');
    fireEvent.change(screen.getByLabelText('Cardholder name'), { target: { value: 'Synthetic Holder' } });
    fireEvent.change(screen.getByLabelText('Expiry month'), { target: { value: '08' } });
    fireEvent.change(screen.getByLabelText('Expiry year'), { target: { value: '2030' } });
    fireEvent.change(screen.getByLabelText('Destination Vault'), { target: { value: 'team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'save', vaultId: 'team', entry: expect.objectContaining({ cardholderName: 'Synthetic Holder', cardNumber: '4111111111111111', expiryYear: '2030' }) })));
    const saved = send.mock.calls.find(call => call[0].type === 'save')![0]; expect(saved.type === 'save' && saved.entry).not.toHaveProperty('cvv');
  });
  it('cancels without calling the mutation and preserves draft on errors', async () => {
    const keyReview = { ...card, candidate: { kind: 'key' as const, value: 'synthetic-secret' } };
    const send = vi.fn(async (command: SecretCapturePopupCommand) => command.type === 'begin-review' ? keyReview : ({ status: 'error' } as const));
    render(<SecretCapturePrompt review={keyReview} client={{} as VaultClient} send={send} onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review in Palladin' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save entry' }));
    await screen.findByText("Couldn't save this entry");
    expect(screen.getByLabelText('Secret value')).toHaveValue('synthetic-secret');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'dismiss', id: 'capture' })));
  });
});

it('unmounts the plaintext editor on termination invalidation and rejects an older pending review', async () => {
  const { useSecretCapture } = await import('./SecretCapturePrompt');
  const listeners = new Set<(event: unknown) => void>();
  let release!: (result: SecretCaptureResult) => void; let requests = 0;
  vi.stubGlobal('chrome', { runtime: {
    sendMessage: async (command: SecretCapturePopupCommand) => command.type === 'begin-review' || ++requests === 1 ? card : new Promise<SecretCaptureResult>(resolve => { release = resolve; }),
    onMessage: { addListener: (listener: (event: unknown) => void) => listeners.add(listener), removeListener: (listener: (event: unknown) => void) => listeners.delete(listener) },
  } });
  function Surface() {
    const [review, done] = useSecretCapture(0);
    return review ? <SecretCapturePrompt review={review} client={{} as VaultClient} onDone={done} /> : null;
  }
  try {
    render(<Surface />); fireEvent.click(await screen.findByRole('button', { name: 'Review in Palladin' }));
    expect(await screen.findByLabelText('Card number')).toHaveValue('4111111111111111');
    await act(async () => { for (const listener of listeners) listener({ type: 'secret-capture/available' }); });
    act(() => { for (const listener of listeners) listener({ type: 'secret-capture/invalidated' }); });
    expect(screen.queryByLabelText('Card number')).not.toBeInTheDocument();
    await act(async () => release(card));
    expect(screen.queryByRole('region', { name: 'Save captured item' })).not.toBeInTheDocument();
  } finally { vi.unstubAllGlobals(); }
});

it('refreshes same-ID previews, explicitly selects latest worker data, and preserves the selected editor draft', async () => {
  const { useSecretCapture } = await import('./SecretCapturePrompt');
  const listeners = new Set<(event: unknown) => void>();
  const enriched = { ...card, candidate: { kind: 'card' as const, cardNumber: '4111111111111111', cardholderName: 'Preview enriched', expiryMonth: '11', expiryYear: '2032' } };
  const selected = { ...enriched, candidate: { ...enriched.candidate, cardholderName: 'Latest at selection' } };
  let current = card;
  const send = vi.fn(async (command: SecretCapturePopupCommand) => command.type === 'begin-review' ? selected : current);
  vi.stubGlobal('chrome', { runtime: { sendMessage: send,
    onMessage: { addListener: (listener: (event: unknown) => void) => listeners.add(listener), removeListener: (listener: (event: unknown) => void) => listeners.delete(listener) },
  } });
  function Surface() {
    const [review, done] = useSecretCapture(0);
    return review ? <><output aria-label="Preview cardholder">{review.candidate.kind === 'card' ? review.candidate.cardholderName : ''}</output><SecretCapturePrompt review={review} client={{} as VaultClient} onDone={done} /></> : null;
  }
  try {
    render(<Surface />); await screen.findByRole('button', { name: 'Review in Palladin' });
    current = enriched;
    await act(async () => { for (const listener of listeners) listener({ type: 'secret-capture/available' }); });
    expect(screen.getByLabelText('Preview cardholder')).toHaveTextContent('Preview enriched');
    fireEvent.click(screen.getByRole('button', { name: 'Review in Palladin' }));
    expect(await screen.findByLabelText('Cardholder name')).toHaveValue('Latest at selection');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'begin-review', id: card.id }));
    fireEvent.change(screen.getByLabelText('Cardholder name'), { target: { value: 'User edited' } });
    current = { ...enriched, candidate: { ...enriched.candidate, cardholderName: 'Later page change' } };
    await act(async () => { for (const listener of listeners) listener({ type: 'secret-capture/available' }); });
    expect(screen.getByLabelText('Cardholder name')).toHaveValue('User edited');
  } finally { vi.unstubAllGlobals(); }
});
