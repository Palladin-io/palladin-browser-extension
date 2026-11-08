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
it('makes only the identity thumbnail interactive and keeps the summary outside the link', () => {
  render(<CaptureReview title="Capture" savedTitle="Saved" origin="example.test" name="Example" detail="alice" identity={{name:'Example',type:1}}
    stage="saved" saveLabel="Save" onIdentity={() => {}} onReview={() => {}} onSave={() => {}} onDone={() => {}} onDismiss={() => {}}>{null}</CaptureReview>);
  const thumbnail = screen.getByRole('button', {name:'Example'});
  expect(thumbnail).not.toContainElement(screen.getByText('alice'));
  expect(screen.queryByText('Captured on example.test')).toBeNull();
});
it('separates dismiss from site mute and closes the menu on Escape and outside interaction', async () => {
  const dismiss=vi.fn(),mute=vi.fn(),user=userEvent.setup();
  render(<CaptureReview title="Capture" savedTitle="Saved" origin="accounts.example.com" name="Example" identity={{name:'Example',type:1}} stage="review" saveLabel="Save" onReview={()=>{}} onSave={()=>{}} onDone={()=>{}} onDismiss={dismiss} onMute={mute}>{null}</CaptureReview>);
  await user.click(screen.getByRole('button',{name:'Dismiss'}));
  expect(dismiss).toHaveBeenCalledTimes(1);expect(mute).not.toHaveBeenCalled();
  const options=screen.getByRole('button',{name:'More dismiss options'});
  options.focus();await user.keyboard('{Enter}');
  expect(screen.getByRole('menuitem')).toHaveTextContent('example.com');
  expect(screen.getByRole('menuitem')).not.toHaveTextContent('accounts.example.com');
  await user.keyboard('{Escape}');expect(screen.queryByRole('menu')).toBeNull();expect(options).toHaveFocus();
  await user.click(options);await user.click(screen.getByRole('button',{name:'Save'}));expect(screen.queryByRole('menu')).toBeNull();
  await user.click(options);await user.click(screen.getByRole('menuitem'));
  expect(mute).toHaveBeenCalledTimes(1);expect(dismiss).toHaveBeenCalledTimes(1);
});
it('shows only Done after saved even when site mute is available', () => {
 render(<CaptureReview title="Capture" savedTitle="Saved" origin="example.com" name="Example" identity={{name:'Example',type:1}} stage="saved" saveLabel="Save" onReview={()=>{}} onSave={()=>{}} onDone={()=>{}} onDismiss={()=>{}} onMute={()=>{}}>{null}</CaptureReview>);
 expect(screen.getAllByRole('button').map(button=>button.textContent)).toEqual(['Done']);
});
