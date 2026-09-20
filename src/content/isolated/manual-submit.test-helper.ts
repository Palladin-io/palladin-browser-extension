import { vi } from 'vitest';

/** Synthetic POST transport for tests whose assertion is actual submit dispatch.
 * Observed HTML stays unchanged on disk. Framework behavior is not captured.
 */
export function observeNativeSubmit(form: HTMLFormElement) {
  form.method = 'post';
  const submit = vi.fn<(submitter: HTMLElement | null) => void>();
  form.addEventListener('submit', event => {
    event.preventDefault();
    submit((event as SubmitEvent).submitter);
  });
  return submit;
}
