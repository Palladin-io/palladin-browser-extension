// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CaptureReview, type CaptureReviewStage } from './CaptureReview';
it('never submits when Review changes the shared footer into a save action', async () => {
  const submit = vi.fn();
  function Review() {
    const [stage, setStage] = useState<CaptureReviewStage>('notice');
    return <CaptureReview title="Capture" savedTitle="Saved" origin="example.test" name="Example" identity={{name:'Example',type:1}}
      stage={stage} saveForm="review-form" saveLabel="Save" onReview={() => setStage('review')} onSave={submit} onDone={() => {}} onDismiss={() => {}}>
      <form id="review-form" onSubmit={event => { event.preventDefault(); submit(); }}><input aria-label="Name" defaultValue="Example" /></form>
    </CaptureReview>;
  }
  render(<Review />);
  let prevented = false;
  const observe = (event: MouseEvent) => { prevented = event.defaultPrevented; };
  document.addEventListener('click', observe, { once: true });
  await userEvent.setup().click(screen.getByRole('button', { name: 'Review' }));
  expect(prevented).toBe(true);
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  expect(submit).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
});
