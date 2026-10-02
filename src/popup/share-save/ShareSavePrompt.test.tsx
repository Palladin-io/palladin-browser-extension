// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ShareSavePrompt, type ShareSaveClient, type ShareSaveView } from './ShareSavePrompt';

const pending: ShareSaveView = { id: '11111111-1111-4111-8111-111111111111', title: 'Synthetic login',
  entryType: 'credential', vaults: [
    { id: '22222222-2222-4222-8222-222222222222', name: 'Personal' },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Team' },
  ] };

function client(saved: boolean): ShareSaveClient {
  return { get: vi.fn(async () => pending), confirm: vi.fn(async () => saved), cancel: vi.fn(async () => undefined) };
}

describe('extension-owned share confirmation', () => {
  it('shows only entry identity and destination, not plaintext fields', () => {
    render(<ShareSavePrompt pending={pending} onDone={() => undefined} client={client(true)} />);
    expect(screen.getByRole('heading', { name: 'Save shared entry' })).toBeInTheDocument();
    expect(screen.getByText('Synthetic login')).toBeInTheDocument();
    expect(screen.getByLabelText('Destination vault')).toBeInTheDocument();
    expect(screen.queryByText('synthetic-password')).not.toBeInTheDocument();
  });

  it('requires an explicit click and saves to the selected vault', async () => {
    const c = client(true);
    render(<ShareSavePrompt pending={pending} onDone={() => undefined} client={c} />);
    expect(c.confirm).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Destination vault'), pending.vaults[1]!.id);
    await user.click(screen.getByRole('button', { name: 'Save to my vault' }));
    await waitFor(() => expect(c.confirm).toHaveBeenCalledWith(pending.id, pending.vaults[1]!.id));
    expect(screen.getByRole('heading', { name: 'Saved to your vault' })).toBeInTheDocument();
  });

  it('shows a generic failure with no secret or raw exception', async () => {
    render(<ShareSavePrompt pending={pending} onDone={() => undefined} client={client(false)} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save to my vault' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save this entry');
  });

  it('starts a new confirmation when a different pending entry replaces a saved one', async () => {
    const c = client(true);
    const { rerender } = render(<ShareSavePrompt key={pending.id} pending={pending} onDone={() => undefined} client={c} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save to my vault' }));
    expect(await screen.findByRole('heading', { name: 'Saved to your vault' })).toBeInTheDocument();
    const next = { ...pending, id: '44444444-4444-4444-8444-444444444444', title: 'Next entry' };
    rerender(<ShareSavePrompt key={next.id} pending={next} onDone={() => undefined} client={c} />);
    expect(screen.getByRole('heading', { name: 'Save shared entry' })).toBeInTheDocument();
    expect(screen.getByText('Next entry')).toBeInTheDocument();
  });
});
