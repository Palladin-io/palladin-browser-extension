/** Compose operation cancellation on browsers without AbortSignal.any.
 * Include an operation-owned signal and abort it in finally so subscriptions to
 * longer-lived route/session signals are released after successful work too. */
export function combineAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const sources = [...new Set(signals)];
  const alreadyAborted = sources.find(signal => signal.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return controller.signal;
  }
  const listeners = new Map<AbortSignal, () => void>();
  const cancel = (source: AbortSignal) => {
    for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    listeners.clear();
    controller.abort(source.reason);
  };
  for (const signal of sources) {
    const listener = () => cancel(signal);
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }
  return controller.signal;
}
