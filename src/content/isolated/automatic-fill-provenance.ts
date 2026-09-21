import { isCurrentLoginTarget, type LoginTarget } from './credential-form-analysis';

interface Receipt {
  readonly target: LoginTarget;
  readonly documentId: string;
  readonly url: string;
  readonly sessionId: string;
  readonly deadline: number;
  readonly fields: { input: HTMLInputElement; value: string }[];
  readonly revoke: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
const receipts = new WeakMap<Document, Set<Receipt>>();
const MAX_AGE_MS = 60_000;

export function clearAutomaticFillProvenance(doc: Document): void {
  for (const receipt of receipts.get(doc) ?? []) receipt.revoke();
}
export function discardAutomaticFillProvenance(target: LoginTarget): void {
  discardAutomaticFillForInputs(target.form.ownerDocument, [target.username, target.password].filter((input): input is HTMLInputElement => input !== null));
}
export function discardAutomaticFillForInputs(doc: Document, inputs: readonly HTMLInputElement[]): void {
  for (const receipt of receipts.get(doc) ?? []) {
    if (receipt.fields.some(field => inputs.includes(field.input))) receipt.revoke();
  }
}

/** Called only after a worker-authenticated automatic fill of previously empty
 * controls. The tuple never leaves this isolated document or enters persistence.
 */
export function rememberAutomaticFill(target: LoginTarget, documentId: string, url: string, sessionId: string): void {
  discardAutomaticFillProvenance(target);
  const doc = target.form.ownerDocument;
  if (doc.location.href !== url || !isCurrentLoginTarget(target)) return;
  const fields = [target.username, target.password].filter((input): input is HTMLInputElement => input !== null)
    .map(input => ({ input, value: input.value }));
  if (fields.length === 0 || fields.some(field => field.value === '')) return;
  const entries = receipts.get(doc) ?? new Set<Receipt>();
  receipts.set(doc, entries);
  const revoke = () => {
    clearTimeout(receipt.timer); entries.delete(receipt);
    for (const field of receipt.fields) {
      field.input.removeEventListener('input', revoke, true);
      field.input.removeEventListener('change', revoke, true);
      field.value = '';
    }
    receipt.fields.length = 0;
    for (const event of ['pagehide', 'popstate', 'hashchange']) doc.defaultView?.removeEventListener(event, revoke);
  };
  const receipt: Receipt = { target, documentId, url, sessionId, fields, revoke,
    deadline: performance.now() + MAX_AGE_MS, timer: setTimeout(revoke, MAX_AGE_MS) };
  entries.add(receipt);
  for (const field of fields) {
    field.input.addEventListener('input', revoke, true);
    field.input.addEventListener('change', revoke, true);
  }
  for (const event of ['pagehide', 'popstate', 'hashchange']) doc.defaultView?.addEventListener(event, revoke);
}

/** One-use permission to replace only this unchanged automatic tuple. No values
 * are returned, and neither manual writes nor matching pre-existing values mint it.
 */
export function takeAutomaticFillProvenance(doc: Document, documentId: string, url: string, sessionId: string,
  inputs: readonly HTMLInputElement[]): boolean {
  const receipt = [...receipts.get(doc) ?? []].find(candidate => inputs.some(input => candidate.fields.some(field => field.input === input)));
  if (!receipt) return false;
  const valid = receipt.documentId === documentId && receipt.sessionId === sessionId
    && receipt.url === url && doc.location.href === url && performance.now() < receipt.deadline
    && isCurrentLoginTarget(receipt.target) && inputs.length > 0
    && inputs.every(input => !input.disabled && !input.readOnly && receipt.fields.some(field => field.input === input))
    && receipt.fields.every(field => field.input.isConnected && field.input.ownerDocument === doc && field.input.value === field.value);
  receipt.revoke();
  return valid;
}
