import { SECRET_CAPTURE_CHANNEL, type SecretCaptureContentCommand } from '@shared/messaging/secret-capture';
import type { SecretCandidate } from '@shared/messaging/secret-capture';
import { detectSecretCandidates, type SecretDetectionOptions } from './secret-detection';
import { SecretCaptureNotice } from './secret-notice';
interface Options {
  send?(command: SecretCaptureContentCommand): Promise<unknown>;
  detect?(doc: Document, options?: SecretDetectionOptions): readonly SecretCandidate[];
  url?(): string;
}
export function startSecretCapture(doc: Document, documentId: string, options: Options = {}) {
  const send = options.send ?? ((command: SecretCaptureContentCommand) => chrome.runtime.sendMessage(command));
  const detect = options.detect ?? detectSecretCandidates;
  const url = options.url ?? (() => doc.location.href);
  let stopped = false, enabled = false, locked = false, revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cardTimer: ReturnType<typeof setTimeout> | undefined;
  let touched = new WeakSet<Element>();
  const cardScopes = new WeakMap<Element, string>();
  const cardScopeId = (group: Element): string => {
    let id = cardScopes.get(group);
    if (!id) { id = crypto.randomUUID().replaceAll('-', ''); cardScopes.set(group, id); }
    return id;
  };
  let action: { scope: Element; expires: number } | null = null;
  const generatedScopes = new Set<Element>();
  let noticeId: string | undefined;
  const command = (type: 'status' | 'open' | 'dismiss', id?: string): SecretCaptureContentCommand => ({ channel: SECRET_CAPTURE_CHANNEL, type, documentId, ...(id ? { id } : {}) });
  const notice = new SecretCaptureNotice(doc, async type => {
    await send(command(type, noticeId));
    if (type === 'dismiss') { noticeId = undefined; notice.hide(); }
  });
  const status = (raw: unknown) => raw && typeof raw === 'object' && 'status' in raw ? String(raw.status) : 'error';
  async function scan(scope?: Element, cards = false, generated = false): Promise<void> {
    if (stopped || !enabled && !locked || new URL(url()).protocol !== 'https:') return;
    const epoch = revision;
    discoverRoots(scope ?? doc);
    if (locked) {
      // Detection is synchronous and discarded here; locked observations never cross messaging or unlock.
      if (detect(doc, { ...(scope ? { scope } : {}), ...(generated ? { trustedGeneratedResult: true } : {}) })
        .some(candidate => candidate.kind === 'key' || cards)) notice.show(true);
      return;
    }
    // Candidate values survive only this observation send; no page-side raw-value suppression cache.
    for (const candidate of detect(doc, { ...(scope ? { scope } : {}), ...(generated ? { trustedGeneratedResult: true } : {}), ...(cards ? { cardScopeId } : {}) })) {
      if (candidate.kind === 'card' && !cards) continue;
      if (stopped || !enabled || epoch !== revision) break;
      try {
        const result: unknown = await send({ channel: SECRET_CAPTURE_CHANNEL, type: 'observe', documentId, candidate });
        if (stopped || epoch !== revision) break;
        if (status(result) === 'accepted' && result && typeof result === 'object' && 'id' in result && typeof result.id === 'string') {
          noticeId = result.id; notice.show(false);
        } else if (status(result) === 'locked') { enabled = false; locked = true; notice.show(true); break; }
      } catch { break; }
    }
  }
  function schedule(scope?: Element, cards = false, generated = false): void {
    if (cards) {
      if (cardTimer !== undefined) clearTimeout(cardTimer);
      cardTimer = setTimeout(() => { cardTimer = undefined; void scan(scope, true); }, 350);
      return;
    }
    if (generated && scope && generatedScopes.size < 8) generatedScopes.add(scope);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const scopes = [...generatedScopes]; generatedScopes.clear();
      if (scopes.length) void (async () => { for (const result of scopes) await scan(result, false, true); })();
      else void scan(scope, cards);
    }, 350);
  }
  function local(target: Element): Element | null {
    if ((target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) && target.form) return target.form;
    const group = target.closest('form,fieldset,section,article,[role="group"],[role="dialog"]')
      ?? target.closest('button,[role="button"],input')?.parentElement ?? null;
    return (group === doc.body || group === doc.documentElement) && target instanceof HTMLInputElement ? target : group;
  }
  function trusted(event: Event): void {
    const target = event.composedPath?.()[0] ?? event.target;
    if (!event.isTrusted || !enabled && !locked || !(target instanceof Element) || notice.isOwnedSurface(target)) return;
    discoverRoots(target.getRootNode());
    const scope = local(target);
    if (scope === doc.body || scope === doc.documentElement) return;
    if (event.type === 'click') {
      if (scope) action = { scope, expires: Date.now() + 10_000 };
    } else if (scope && (event.type !== 'blur' || touched.has(scope))) { touched.add(scope); schedule(scope, true); }
  }
  const observer = new MutationObserver(records => {
    if (!enabled && !locked || stopped) return;
    const relevant = records.slice(0, 64).filter(record => !(record.target instanceof Element && notice.isOwnedSurface(record.target)));
    if (!relevant.length) return;
    let additions = 0;
    for (const record of relevant) for (const node of record.addedNodes) {
      if (additions++ >= 8) break;
      if (node instanceof Element) discoverRoots(node);
    }
    let scheduled = false;
    if (action && action.expires > Date.now() && action.scope.isConnected) {
      for (const record of relevant) {
        if (!action.scope.contains(record.target)) continue;
        const nodes = record.addedNodes.length ? [...record.addedNodes].slice(0, 8) : [record.target];
        for (const node of nodes) {
          const scope = node instanceof Element ? node : node.parentElement;
          if (!scope || scope === action.scope || !scope.isConnected || scope.closest('button,[role="button"]')) continue;
          schedule(scope, false, true); scheduled = true;
        }
      }
    }
    if (!scheduled) schedule();
  });
  const mutationOptions = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['value','readonly','hidden','style'] };
  const observed = new WeakSet<Node>();
  function discoverRoots(root: Node): void {
    const queue: Node[] = [root]; let remaining = 2_000;
    while (queue.length && remaining > 0) {
      const next = queue.pop()!;
      if ((next instanceof ShadowRoot || next === doc) && !observed.has(next)) {
        observed.add(next); observer.observe(next, mutationOptions);
      }
      const walk = doc.createTreeWalker(next, NodeFilter.SHOW_ELEMENT);
      let node: Node | null = next instanceof Element ? next : walk.nextNode();
      while (node && remaining-- > 0) {
        if (node instanceof Element && node.shadowRoot) queue.push(node.shadowRoot);
        node = walk.nextNode();
      }
    }
  }
  discoverRoots(doc);
  for (const type of ['input','change','blur','click']) doc.addEventListener(type, trusted, true);
  async function refresh(unlocked?: boolean): Promise<void> {
    const epoch = ++revision; action = null; generatedScopes.clear(); touched = new WeakSet();
    if (cardTimer !== undefined) clearTimeout(cardTimer);
    if (timer !== undefined) clearTimeout(timer);
    const wasLocked = locked; enabled = false; locked = false;
    if (unlocked === false) { locked = true; if (noticeId) notice.show(true); noticeId = undefined; schedule(); return; }
    try {
      const result = await send(command('status'));
      if (stopped || epoch !== revision) return;
      locked = status(result) === 'locked';
      enabled = !['locked','stale','error','muted'].includes(status(result));
      if (enabled && wasLocked) { noticeId = undefined; notice.hide(); }
      if (enabled || locked) schedule(); else if (noticeId) notice.show(true);
    } catch { enabled = false; }
  }
  void refresh();
  return {
    refresh,
    isOwnedSurface: (element: Element) => notice.isOwnedSurface(element),
    stop() {
      stopped = true; revision++; enabled = false; locked = false; action = null; generatedScopes.clear(); noticeId = undefined;
      observer.disconnect(); if (cardTimer !== undefined) clearTimeout(cardTimer); if (timer !== undefined) clearTimeout(timer);
      for (const type of ['input','change','blur','click']) doc.removeEventListener(type, trusted, true);
      notice.stop();
    },
  };
}
