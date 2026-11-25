import {
  INLINE_AUTOFILL_CHANNEL, generateNonce, isInlineAutofillResult,
  type FillOutcome, type FillRequestMessage, type InlineAutofillSuggestion,
} from '@shared/messaging';
import type { SignInSuggestion } from '@shared/messaging/federated-signin';
import { SIGN_IN_PROVIDER_NAMES } from '@shared/signin/providers';
import { ONE_CLICK_CHANNEL, isOneClickResult, type OneClickResult, type OneClickRun, type OneClickStage } from '@shared/messaging/one-click';
import { DEFAULT_UI_PREFERENCES, UI_PREFERENCES_STORAGE_KEY, parseUiPreferences, resolveUiLocale } from '@shared/config/ui-preferences';
import { matchesTab, registrableDomain } from '@shared/security/domain';
import { createAgentInjectDomAccess } from './agent-inject';
import { hasLiveLoginObstacle } from './agent-live-obstacles';
import { isFillable } from './credential-form-analysis';
import { clickWithGetGuard, performBoundFill, submitFilledLoginTarget, type LoginTarget } from './fill';
import { autocompleteTokens, hasOneTimeCodeHint } from './form-semantics';
import { credentialScopeFor } from './login-controls';
import { composedForm, queryOpenElements } from './open-dom';
import { OneClickToast, type OneClickAccount, type OneClickCopyKey } from './one-click-toast';
import { signInActionFor, verificationActionFor } from './sign-in-action';
import { observeSignInStep, isRegistrationUrl, type SignInStep } from './sign-in-step';
import { observeSignedState } from './signed-out';
import { bindTotpTarget, fillTotp, type TotpBinding } from './totp-target';

export const ONE_CLICK_MUTED_KEY = 'palladin.one-click.muted-hosts.v1';
const MAX_MUTED = 500;
const SCAN_DELAY_MS = 700;
const SETTLE_MS = 250;
const STEP_WAIT_MS = 15_000;
const ENTRY_WAIT_MS = 10_000;

type Body = { readonly type: 'start'; readonly vaultId: string; readonly entryId: string }
  | { readonly type: 'resume' | 'dismiss' | 'prompt-missing' }
  | { readonly type: 'step'; readonly runId: string; readonly stage: OneClickStage }
  | { readonly type: 'stop'; readonly runId: string };
type Outcome = 'continue' | 'done' | OneClickCopyKey | 'check';
type Pending =
  | { readonly id: string; readonly kind: 'credential'; readonly target: LoginTarget }
  | { readonly id: string; readonly kind: 'totp'; readonly inputs: HTMLInputElement[]; readonly binding: TotpBinding };

/** Top-frame controller. It proposes; the worker authorizes every stage and value. */
export function startOneClick(doc: Document, documentId: string, isOtherOwnedSurface: (element: Element) => boolean) {
  const view = doc.defaultView!;
  const host = doc.location.hostname.toLowerCase();
  const url = () => doc.location.href;
  let stopped = false, hidden = false, muted = true, shown = false, popupFilled = false, missingReported = false;
  let running: { run: OneClickRun; account: OneClickAccount; cancelled: boolean } | null = null;
  let pending: Pending | null = null;
  let suggestions: readonly InlineAutofillSuggestion[] = [];
  let federated: { items: readonly SignInSuggestion[]; choose(item: SignInSuggestion): 'opened' | 'manual' } | null = null;
  let status: 'unknown' | 'ready' | 'locked' | 'none' = 'unknown';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const entryByAccount = new Map<string, InlineAutofillSuggestion | SignInSuggestion>();
  const owned = (element: Element) => toast.isOwnedSurface(element) || isOtherOwnedSurface(element);
  const dom = createAgentInjectDomAccess(doc, owned);

  const send = async (body: Body): Promise<OneClickResult | null> => {
    try {
      const result: unknown = await chrome.runtime.sendMessage({ ...body, channel: ONE_CLICK_CHANNEL, documentId });
      return isOneClickResult(result) ? result : null;
    } catch { return null; }
  };
  const inline = async (body: Record<string, unknown>) => {
    try {
      const result: unknown = await chrome.runtime.sendMessage({ ...body, channel: INLINE_AUTOFILL_CHANNEL, documentId });
      return isInlineAutofillResult(result) && result.ok ? result : null;
    } catch { return null; }
  };

  const toast = new OneClickToast(doc, host, {
    signIn: account => void begin(account),
    unlock: () => { void inline({ type: 'inline/open-palladin' }); },
    stop: () => { const current = running; cancelRun(); if (current) void send({ type: 'stop', runId: current.run.runId }); present(); },
    dismiss: () => { hidden = true; cancelRun(); toast.hide(); void send({ type: 'dismiss' }); },
    mute: () => { muted = true; hidden = true; toast.hide(); void send({ type: 'dismiss' }); void rememberMute(); },
  });

  async function rememberMute(): Promise<void> {
    try {
      const stored = (await chrome.storage.local.get(ONE_CLICK_MUTED_KEY))[ONE_CLICK_MUTED_KEY];
      const hosts = Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : [];
      await chrome.storage.local.set({ [ONE_CLICK_MUTED_KEY]: [...new Set([...hosts, host])].slice(-MAX_MUTED) });
    } catch { /* The toast is already hidden for this tab. */ }
  }

  function cancelRun(): void { if (running) running.cancelled = true; running = null; pending = null; }

  function accounts(): OneClickAccount[] {
    entryByAccount.clear();
    const list: OneClickAccount[] = [];
    for (const entry of suggestions) {
      if (entry.username === '') continue;
      const id = `c:${entry.vaultId}:${entry.entryId}`;
      entryByAccount.set(id, entry);
      list.push({ id, name: entry.name, username: entry.username, vault: entry.vaultName,
        ...(entry.match === 'related' ? { host } : {}), ...(entry.iconDataUrl ? { icon: entry.iconDataUrl } : {}) });
    }
    for (const item of federated?.items ?? []) {
      const id = `p:${item.id}`;
      entryByAccount.set(id, item);
      list.push({ id, name: SIGN_IN_PROVIDER_NAMES[item.provider], username: item.account ?? item.label, vault: item.vaultLabel, provider: item.provider });
    }
    return list;
  }

  function schedule(): void {
    if (timer !== null || stopped || hidden || muted || running !== null || status === 'none') return;
    timer = setTimeout(() => { timer = null; present(); }, SCAN_DELAY_MS);
  }

  function signedOutStep(): SignInStep | null {
    if (isRegistrationUrl(url())) return null;
    const step = observeSignInStep(doc, url());
    const form = isCredential(step);
    if (form && step.kind !== 'password' && step.action === null) return null;
    return observeSignedState(doc, form).state === 'signed-out' ? step : null;
  }

  function present(): void {
    if (stopped || hidden || muted || running !== null || view.top !== view) return;
    // One notice at a time: a pending save or confirmation keeps its place.
    if ([...doc.querySelectorAll('palladin-capture')].some(element => !toast.isOwnedSurface(element))) { toast.hide(); presentedKey = ''; return; }
    const step = signedOutStep();
    const list = status === 'ready' ? accounts() : [];
    if (step === null || (status === 'ready' && list.length === 0) || (status === 'locked' && !isCredential(step))
      || status === 'unknown' || status === 'none') { toast.hide(); return; }
    shown = true;
    if (status === 'locked') { if (!toast.visible) toast.showLocked(); return; }
    const key = list.map(account => account.id).join();
    if (toast.visible && key === presentedKey) return;
    presentedKey = key;
    toast.showReady(list);
  }
  let presentedKey = '';

  async function refresh(): Promise<void> {
    if (stopped || muted) return;
    const resumed = await send({ type: 'resume' });
    if (stopped) return;
    if (resumed?.status === 'hidden') { hidden = true; return; }
    if (resumed?.status === 'run') { void drive(resumed.run, accountFor(resumed.run)); return; }
    const result = await inline({ type: 'inline/list' });
    if (stopped || result?.kind !== 'suggestions') return;
    suggestions = result.status === 'ready' ? result.entries : [];
    status = result.status === 'locked' ? 'locked' : result.status === 'ready' && (suggestions.length > 0 || federated !== null) ? 'ready' : 'none';
    presentedKey = '';
    present();
  }

  function accountFor(run: OneClickRun): OneClickAccount {
    return { id: `c:${run.vaultId}:${run.entryId}`, name: run.name, username: run.username, vault: '' };
  }

  async function begin(account: OneClickAccount): Promise<void> {
    const entry = entryByAccount.get(account.id);
    if (!entry || running !== null) return;
    if ('provider' in entry) {
      // Synchronous inside the trusted click, so a provider popup keeps its activation.
      const name = SIGN_IN_PROVIDER_NAMES[entry.provider];
      toast.showHandOff(account, federated?.choose(entry) === 'opened' ? 'oneClick.chooseProvider' : 'oneClick.noAction', name);
      return;
    }
    const result = await send({ type: 'start', vaultId: entry.vaultId, entryId: entry.entryId });
    if (stopped || result?.status !== 'run') { present(); return; }
    await drive(result.run, account);
  }

  const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

  async function drive(run: OneClickRun, account: OneClickAccount): Promise<void> {
    if (running !== null) return;
    const current = { run, account, cancelled: false };
    running = current;
    const alive = () => running === current && !current.cancelled && !stopped;
    let outcome: Outcome = 'continue';
    let previous: string | null = null;
    let deadline = performance.now() + ENTRY_WAIT_MS;
    try {
      while (alive() && outcome === 'continue') {
        const step = observeSignInStep(doc, url());
        const key = stepKey(step);
        if (key !== null && key === previous) {
          if (performance.now() >= deadline) outcome = 'check';
          else await wait(SETTLE_MS);
          continue;
        }
        if (isCredential(step) || step.kind === 'totp') {
          previous = key;
          outcome = await perform(step, current, alive);
          deadline = performance.now() + STEP_WAIT_MS;
          continue;
        }
        if (codeFieldVisible()) { outcome = 'oneClick.sms'; continue; }
        const signed = observeSignedState(doc, false);
        if (previous === null && signed.state === 'signed-out' && signed.entry !== null) {
          previous = 'entry';
          outcome = await openEntry(signed.entry, current, alive);
          deadline = performance.now() + STEP_WAIT_MS;
          continue;
        }
        if (signed.state === 'signed-in') { outcome = 'done'; continue; }
        // No further stage is not proof of success, so nothing is claimed.
        if (performance.now() >= deadline) outcome = previous === 'entry' ? 'oneClick.noAction' : 'done';
        else await wait(SETTLE_MS);
      }
    } catch { outcome = 'check'; }
    if (!alive()) return;
    running = null; pending = null;
    void send({ type: 'stop', runId: run.runId });
    hidden = true;
    if (outcome === 'done') { toast.hide(); void send({ type: 'dismiss' }); }
    else toast.showHandOff(account, outcome === 'check' || outcome === 'continue' ? undefined : outcome);
  }

  function stepKey(step: SignInStep): string | null {
    if (isCredential(step)) return `${step.kind}:${identity(step.target.username ?? step.target.password!)}`;
    return step.kind === 'totp' ? `totp:${identity(step.inputs[0]!)}` : null;
  }
  const identities = new WeakMap<Element, number>();
  let nextIdentity = 0;
  function identity(element: Element): number {
    if (!identities.has(element)) identities.set(element, ++nextIdentity);
    return identities.get(element)!;
  }

  async function grant(stage: OneClickStage, run: OneClickRun): Promise<boolean> {
    return (await send({ type: 'step', runId: run.runId, stage }))?.status === 'granted';
  }

  async function openEntry(entry: HTMLElement, current: { run: OneClickRun; account: OneClickAccount }, alive: () => boolean): Promise<Outcome> {
    toast.showProgress(current.account, 'oneClick.entry');
    if (entry instanceof HTMLAnchorElement && entry.hasAttribute('href')) {
      const site = registrableDomain(host);
      try {
        const target = new URL(entry.href, doc.baseURI);
        if (target.protocol !== 'https:' || site === null || registrableDomain(target.hostname) !== site
          || !['', '_self'].includes(entry.target)) return 'oneClick.noAction';
      } catch { return 'oneClick.noAction'; }
    }
    if (!await grant('entry', current.run) || !alive() || !entry.isConnected) return 'oneClick.noAction';
    entry.click();
    return 'continue';
  }

  async function perform(step: SignInStep, current: { run: OneClickRun; account: OneClickAccount }, alive: () => boolean): Promise<Outcome> {
    const { run, account } = current;
    if (step.kind === 'totp') {
      toast.showProgress(account, 'oneClick.totp');
      if (!await grant('totp', run) || !alive()) return 'check';
      let binding: TotpBinding | null = null;
      // Passive autofill may write the same entry's code between binding and
      // delivery. Rebind once to the current values; never force a stale binding.
      for (let attempt = 0; attempt < 2; attempt++) {
        binding = bindTotpTarget(doc, step.inputs);
        if (!binding) return 'check';
        const id = generateNonce();
        pending = { id, kind: 'totp', inputs: step.inputs, binding };
        const filled = await inline({ type: 'inline/fill', intent: 'manual', purpose: 'totp', vaultId: run.vaultId, entryId: run.entryId, scope: run.match, loginTargetId: id });
        pending = null;
        if (!alive()) return 'continue';
        if (filled?.kind === 'fill' && filled.status === 'filled') break;
        if (attempt === 1) return 'oneClick.sms';
        await wait(SETTLE_MS);
      }
      if (binding === null) return 'check';
      const startUrl = url();
      // Many sites submit a complete code themselves; never submit it twice.
      await wait(700);
      if (!alive() || url() !== startUrl || !step.inputs.every(input => input.isConnected && isFillable(input))) return 'continue';
      const action = verificationActionFor(step.inputs[0]!, binding.scope as HTMLElement);
      if (action === null) return 'oneClick.noAction';
      if (!action.ready || !binding.current()) return 'continue';
      click(action.element, binding.scope);
      return 'continue';
    }
    if (!isCredential(step)) return 'check';
    if (hasLiveLoginObstacle(doc, step.target.form, dom)) return 'oneClick.captcha';
    toast.showProgress(account, step.kind === 'identifier' ? 'oneClick.identifier' : 'oneClick.password');
    if (!await grant(step.kind, run) || !alive()) return 'check';
    const id = generateNonce();
    pending = { id, kind: 'credential', target: step.target };
    const filled = await inline({ type: 'inline/fill', intent: 'manual', vaultId: run.vaultId, entryId: run.entryId, scope: run.match, loginTargetId: id });
    pending = null;
    if (!alive()) return 'continue';
    if (filled?.kind !== 'fill' || filled.status !== 'filled') return 'check';
    if (step.needsUser) return 'oneClick.noAction';
    const submitted = await submitFilledLoginTarget(step.target, alive, () => {
      if (hasLiveLoginObstacle(doc, step.target.form, dom)) return false;
      const action = signInActionFor(step.target);
      return action !== null && action.ready && !owned(action.element) && click(action.element, step.target.form);
    });
    if (submitted === 'submitted') return 'continue';
    if (submitted === 'no-action' && alive()) void inline({ type: 'inline/submit-unavailable' });
    return hasLiveLoginObstacle(doc, step.target.form, dom) ? 'oneClick.captcha' : 'oneClick.noAction';
  }

  function click(action: HTMLElement, scope: Element): boolean {
    const form = composedForm(action);
    if (form !== null) {
      // The approved value must not leave for another origin.
      const submitter = action instanceof HTMLButtonElement || action instanceof HTMLInputElement ? action : null;
      const destination = new URL((submitter?.type === 'submit' ? submitter.getAttribute('formaction') : null) ?? form.getAttribute('action') ?? url(), doc.baseURI);
      const target = (submitter?.type === 'submit' ? submitter.getAttribute('formtarget') : null) ?? form.getAttribute('target') ?? '_self';
      if (destination.protocol !== 'https:' || registrableDomain(destination.hostname) !== registrableDomain(host)
        || !['', '_self', '_top'].includes(target)) return false;
    }
    return clickWithGetGuard(action, scope, form);
  }

  function codeFieldVisible(): boolean {
    return queryOpenElements<HTMLInputElement>(doc, 'input').some(input => isFillable(input) && hasOneTimeCodeHint(input));
  }

  // --- Missing-prompt signal: a trusted manual password submission on a page where nothing was offered. ---
  function manualSignIn(): void {
    if (running !== null) return;
    if (!missingReported && !shown && !hidden && !muted && status !== 'locked') { missingReported = true; void send({ type: 'prompt-missing' }); }
    // The user is already signing in on their own; do not offer it again on this page.
    hidden = true;
    toast.hide();
  }
  function filledPassword(scope: Element | null): boolean {
    return scope !== null && queryOpenElements<HTMLInputElement>(scope, 'input[type="password"]').some(input =>
      input.value !== '' && isFillable(input) && !autocompleteTokens(input).includes('new-password'));
  }
  const submitted = (event: Event) => {
    if (!event.isTrusted || isRegistrationUrl(url()) || !(event.target instanceof Element)) return;
    if (event instanceof KeyboardEvent) {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type === 'password'
        && filledPassword(credentialScopeFor(event.target) ?? event.target.parentElement)) manualSignIn();
      return;
    }
    const control = event.target.closest('button, input[type="submit"], [role="button"]');
    if (control !== null && !owned(control) && filledPassword(credentialScopeFor(control))) {
      const step = observeSignInStep(doc, url());
      // A visibility toggle is not a submission: require the action Palladin would use, or an unrecognized form.
      if (!isCredential(step) || step.action?.element === control || step.action === null) manualSignIn();
    }
  };
  // Palladin's own writes are untrusted events, so this is the user typing.
  const typed = (event: Event) => {
    if (!event.isTrusted || running !== null || hidden || !(event.target instanceof HTMLInputElement)) return;
    const step = observeSignInStep(doc, url());
    if (!isCredential(step) || (event.target !== step.target.username && event.target !== step.target.password)) return;
    if (signedOutStep() !== null) shown = true;
    hidden = true;
    toast.hide();
  };
  doc.addEventListener('input', typed, true);
  doc.addEventListener('click', submitted, true);
  doc.addEventListener('keydown', submitted, true);

  const observer = new MutationObserver(schedule);
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled'] });
  const applyPreferences = (value: unknown) => {
    const preferences = value === undefined ? DEFAULT_UI_PREFERENCES : parseUiPreferences(value);
    toast.setAppearance(resolveUiLocale(preferences.language, chrome.i18n.getUILanguage()), preferences.theme);
  };
  const storageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && UI_PREFERENCES_STORAGE_KEY in changes) applyPreferences(changes[UI_PREFERENCES_STORAGE_KEY]?.newValue);
  };
  chrome.storage.onChanged.addListener(storageChanged);
  void chrome.storage.local.get([UI_PREFERENCES_STORAGE_KEY, ONE_CLICK_MUTED_KEY]).then(values => {
    if (stopped) return;
    applyPreferences(values[UI_PREFERENCES_STORAGE_KEY]);
    const hosts: unknown = values[ONE_CLICK_MUTED_KEY];
    muted = Array.isArray(hosts) && hosts.includes(host);
    return refresh();
  }).catch(() => undefined);

  return {
    isOwnedSurface: (element: Element) => toast.isOwnedSurface(element),
    performFillRequest(request: FillRequestMessage): FillOutcome | null {
      if (request.loginTargetId === null && request.fields.some(field => field.kind === 'password')) popupFilled = true;
      const current = pending;
      if (current === null || request.loginTargetId !== current.id) return null;
      pending = null;
      if (request.intent !== 'manual') return { ok: false, reason: 'target-changed' };
      if (current.kind === 'credential') return performBoundFill(doc, request, url(), documentId, current.target);
      const otp = request.fields.find(field => field.kind === 'totp');
      if (!otp || typeof otp.expiresAt !== 'number' || typeof otp.username !== 'string' || request.documentId !== documentId
        || doc.location.origin !== request.expectedOrigin || request.expectedDomain === null || !matchesTab(url(), request.expectedDomain)
        || !current.binding.current()) return { ok: false, reason: 'target-changed' };
      return fillTotp(doc, current.inputs, otp.value, otp.expiresAt, otp.username, true, current.binding, () => !stopped && running !== null)
        ? { ok: true } : { ok: false, reason: 'target-changed' };
    },
    /** A popup fill without any offered toast is strong evidence of a missed page. */
    popupFillCompleted(outcome: FillOutcome): void { if (popupFilled && outcome.ok) manualSignIn(); popupFilled = false; },
    takeSuggestions(items: readonly SignInSuggestion[], choose: (item: SignInSuggestion) => 'opened' | 'manual'): boolean {
      if (stopped || hidden || muted || items.length === 0) return false;
      federated = { items, choose };
      if (status === 'none' || status === 'unknown') status = 'ready';
      presentedKey = '';
      present();
      return toast.visible;
    },
    sessionChanged(unlocked: boolean): void {
      if (!unlocked) { cancelRun(); suggestions = []; federated = null; toast.hide(); }
      status = 'unknown';
      void refresh();
    },
    vaultChanged(): void { if (running === null) void refresh(); },
    stop(): void {
      stopped = true; cancelRun();
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
      doc.removeEventListener('input', typed, true);
      doc.removeEventListener('click', submitted, true);
      doc.removeEventListener('keydown', submitted, true);
      chrome.storage.onChanged.removeListener(storageChanged);
      toast.hide();
    },
  };
}

function isCredential(step: SignInStep): step is Extract<SignInStep, { target: LoginTarget }> {
  return step.kind === 'identifier' || step.kind === 'password' || step.kind === 'login';
}
