import { CAPTURE_DETECTED_CHANNEL, GENERATE_PASSWORD_CHANNEL, GENERATOR_SUGGESTIONS_KEY } from '@shared/messaging/capture';
import { UI_PREFERENCES_STORAGE_KEY, parseUiPreferences, resolveUiLocale } from '@shared/config/ui-preferences';
import en from '../../popup/locales/en.json';
import pl from '../../popup/locales/pl.json';
import { createClosedSurface } from './closed-surface';
import { INLINE_STYLES } from './inline-autofill';
import type { PasswordCaptureController } from './capture';

export function startGeneratorSuggestion(doc: Document, documentId: string, capture: PasswordCaptureController) {
  let surface: ReturnType<typeof createClosedSurface> | null = null;
  let selected: HTMLInputElement | null = null;
  let stopped = false;
  let enabled = false;
  let generation = 0;
  let preferences = parseUiPreferences(undefined);
  const hide = () => { generation++; capture.cancelGeneration(); surface?.host.remove(); surface = null; selected = null; };
  const copy = (key: keyof typeof en) => {
    const locale = resolveUiLocale(preferences.language, chrome.i18n.getUILanguage());
    return (locale === 'pl' ? pl : en)[key];
  };
  const reposition = () => {
    if (!surface || !selected) return;
    const box = selected.getBoundingClientRect();
    if (!selected.isConnected || box.width < 40 || box.height < 20 || box.bottom < 0 || box.top > (doc.defaultView?.innerHeight ?? 0)) { hide(); return; }
    surface.host.style.setProperty('left', `${Math.max(12, Math.min(box.left, (doc.defaultView?.innerWidth ?? 368) - 356))}px`, 'important');
    surface.host.style.setProperty('top', `${Math.max(4, Math.min(box.bottom + 4, (doc.defaultView?.innerHeight ?? 500) - 160))}px`, 'important');
  };
  const show = (input: HTMLInputElement) => {
    if (stopped || !enabled || selected === input) return;
    hide();
    const candidate = capture.candidateFor(input);
    if (!candidate) return;
    selected = input;
    surface = createClosedSurface(doc, 'palladin-autofill');
    const current = surface;
    current.host.style.setProperty('pointer-events', 'auto', 'important');
    const token = generation;
    current.host.dataset.theme = preferences.theme === 'system'
      ? doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : preferences.theme;
    const style = doc.createElement('style'); style.textContent = INLINE_STYLES;
    const panel = doc.createElement('div'); panel.className = 'panel'; panel.style.position = 'relative'; panel.style.top = '0';
    const title = doc.createElement('div'); title.className = 'title'; title.textContent = copy('capture.useStrong');
    const actions = doc.createElement('div'); actions.className = 'session-required';
    const button = doc.createElement('button'); button.className = 'open-palladin'; button.type = 'button'; button.textContent = copy('capture.useStrong');
    const status = doc.createElement('div'); status.className = 'status'; status.setAttribute('role', 'status'); status.textContent = copy('generator.inlineNote');
    const dismiss = doc.createElement('button'); dismiss.type = 'button'; dismiss.className = 'option'; dismiss.textContent = copy('capture.notNow');
    dismiss.addEventListener('click', event => { if (current.acceptsAction(event, dismiss)) hide(); });
    button.addEventListener('click', event => {
      if (!current.acceptsAction(event, button) || capture.candidateFor(input)?.id !== candidate.id) return;
      button.disabled = true;
      const operationId = crypto.randomUUID();
      capture.authorizeGeneration(candidate.id, operationId);
      void chrome.runtime.sendMessage({ channel: CAPTURE_DETECTED_CHANNEL, documentId, candidateId: candidate.id, kind: candidate.kind }).then(ack => {
        if (!ack?.accepted || stopped || generation !== token) return null;
        return chrome.runtime.sendMessage({ channel: GENERATE_PASSWORD_CHANNEL, documentId, candidateId: candidate.id, operationId });
      }).then(result => {
        if (stopped || generation !== token) return;
        if (result?.status === 'filled') { hide(); return; }
        status.textContent = copy('generator.inlineError'); button.disabled = false;
      }, () => {
        if (generation === token) { status.textContent = copy('generator.inlineError'); button.disabled = false; }
      });
    });
    actions.append(status, button, dismiss); panel.append(title, actions); current.shadow.append(style, panel);
    doc.documentElement.append(current.host); reposition();
  };
  const focus = (event: FocusEvent) => {
    if (event.target === surface?.host) return;
    if (event.target instanceof HTMLInputElement) show(event.target); else hide();
  };
  const input = () => { if (selected?.value) hide(); };
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
  const changes = (values: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    if (!(GENERATOR_SUGGESTIONS_KEY in values) && !(UI_PREFERENCES_STORAGE_KEY in values)) return;
    if (GENERATOR_SUGGESTIONS_KEY in values) enabled = values[GENERATOR_SUGGESTIONS_KEY]?.newValue !== false;
    if (UI_PREFERENCES_STORAGE_KEY in values) preferences = parseUiPreferences(values[UI_PREFERENCES_STORAGE_KEY]?.newValue);
    hide();
  };
  doc.addEventListener('focusin', focus);
  doc.addEventListener('input', input);
  doc.addEventListener('keydown', key);
  doc.addEventListener('scroll', reposition, true);
  doc.defaultView?.addEventListener('resize', reposition);
  chrome.storage.onChanged.addListener(changes);
  void chrome.storage.local.get([GENERATOR_SUGGESTIONS_KEY, UI_PREFERENCES_STORAGE_KEY]).then(values => {
    if (stopped) return;
    enabled = values[GENERATOR_SUGGESTIONS_KEY] !== false;
    preferences = parseUiPreferences(values[UI_PREFERENCES_STORAGE_KEY]);
    if (doc.activeElement instanceof HTMLInputElement) show(doc.activeElement);
  }).catch(() => { enabled = false; hide(); });
  return {
    isOwnedSurface: (element: Element) => element === surface?.host,
    hide,
    stop() {
      stopped = true; hide();
      doc.removeEventListener('focusin', focus); doc.removeEventListener('input', input);
      doc.removeEventListener('keydown', key); doc.removeEventListener('scroll', reposition, true);
      doc.defaultView?.removeEventListener('resize', reposition); chrome.storage.onChanged.removeListener(changes);
    },
  };
}
