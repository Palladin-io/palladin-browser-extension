// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { GrantsPanel } from './GrantsPanel';
import { AuditPanel } from './AuditPanel';
import { createWorkspaceClient } from './client';

it('shows permission failure instead of claiming that grants are empty', async () => {
  const client = createWorkspaceClient(async () => ({ ok: false, code: 'forbidden', httpStatus: 403 }));
  render(<GrantsPanel client={client} revision={0} entries={[]} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 403');
  expect(screen.queryByText('No requests to show.')).not.toBeInTheDocument();
});

it('retains a useful audit error when the worker cannot reach the API', async () => {
  const client = createWorkspaceClient(async () => ({ ok: false, code: 'transport' }));
  render(<AuditPanel client={client} entries={[]} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('[transport]');
});
