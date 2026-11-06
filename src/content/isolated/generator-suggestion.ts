import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSPHRASE_DEFAULT_WORDS, PASSPHRASE_MIN_WORDS, PASSPHRASE_MAX_WORDS } from '@palladin/crypto';
import { CAPTURE_DETECTED_CHANNEL, GENERATE_PASSWORD_CHANNEL, GENERATOR_SUGGESTIONS_KEY, GENERATED_PASSWORD_LENGTH, type InlineGeneratorOptions } from '@shared/messaging/capture';
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
    surface.host.style.setProperty('top', `${Math.max(4, Math.min(box.bottom + 4, (doc.defaultView?.innerHeight ?? 500) - (surface.host.getBoundingClientRect().height || 160)))}px`, 'important');
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
    const style = doc.createElement('style'); style.textContent = INLINE_STYLES + GENERATOR_STYLES;
    const panel = doc.createElement('div'); panel.className = 'panel'; panel.style.position = 'relative'; panel.style.top = '0';
    const title = doc.createElement('div'); title.className = 'title generator-title'; title.textContent = copy('capture.useStrong');
    const actions = doc.createElement('div'); actions.className = 'generator-footer';
    const button = doc.createElement('button'); button.className = 'open-palladin'; button.type = 'button'; button.textContent = copy('capture.useStrong');
    const status = doc.createElement('div'); status.className = 'status'; status.setAttribute('role', 'status'); status.textContent = copy('generator.inlineNote');
    const dismiss = doc.createElement('button'); dismiss.type = 'button'; dismiss.className = 'generator-control'; dismiss.textContent = copy('capture.notNow');
    dismiss.addEventListener('click', event => { if (current.acceptsAction(event, dismiss)) hide(); });
    button.addEventListener('click', event => {
      if (!current.acceptsAction(event, button) || capture.candidateFor(input)?.id !== candidate.id) return;
      if (button.disabled) return;
      button.disabled = true;
      const settings = { ...generatorOptions };
      optionsToggle.disabled = true;
      optionsBody.inert = true;
      const operationId = crypto.randomUUID();
      capture.authorizeGeneration(candidate.id, operationId);
      void chrome.runtime.sendMessage({ channel: CAPTURE_DETECTED_CHANNEL, documentId, candidateId: candidate.id, kind: candidate.kind }).then(ack => {
        if (!ack?.accepted || stopped || generation !== token) return null;
        return chrome.runtime.sendMessage({ channel: GENERATE_PASSWORD_CHANNEL, documentId, candidateId: candidate.id, operationId, options: settings });
      }).then(result => {
        if (stopped || generation !== token) return;
        if (result?.status === 'filled') { hide(); return; }
        status.textContent = copy('generator.inlineError'); button.disabled = false; optionsToggle.disabled = false; optionsBody.inert = !optionsOpen;
      }, () => {
        if (generation === token) { status.textContent = copy('generator.inlineError'); button.disabled = false; optionsToggle.disabled = false; optionsBody.inert = !optionsOpen; }
      });
    });
    let generatorOptions: InlineGeneratorOptions = { mode: 'password', length: GENERATED_PASSWORD_LENGTH, digits: true, symbols: true };
    let optionsOpen = false;
    const optionsToggle = doc.createElement('button'); optionsToggle.type = 'button'; optionsToggle.className = 'generator-control generator-options-toggle';
    optionsToggle.textContent = copy('generator.options'); optionsToggle.setAttribute('aria-expanded', 'false'); optionsToggle.setAttribute('aria-controls', 'generator-options');
    const optionsBody = doc.createElement('div'); optionsBody.className = 'generator-options'; optionsBody.id = 'generator-options'; optionsBody.inert = true;
    const optionsInner = doc.createElement('div'); optionsInner.className = 'generator-options-inner'; optionsBody.append(optionsInner);
    optionsToggle.addEventListener('click', event => {
      if (!current.acceptsAction(event, optionsToggle) || optionsToggle.disabled) return;
      optionsOpen = !optionsOpen; optionsToggle.setAttribute('aria-expanded', String(optionsOpen));
      optionsBody.classList.toggle('expanded', optionsOpen); optionsBody.inert = !optionsOpen;
      optionsBody.setAttribute('aria-hidden', String(!optionsOpen)); reposition();
    });
    optionsBody.setAttribute('aria-hidden', 'true');
    optionsBody.addEventListener('transitionend', reposition);
    function control(label: string, action: () => void, pressed?: boolean): HTMLButtonElement {
      const item = doc.createElement('button'); item.type = 'button'; item.className = 'generator-control'; item.textContent = label;
      if (pressed !== undefined) item.setAttribute('aria-pressed', String(pressed));
      item.addEventListener('click', event => {
        if (!current.acceptsAction(event, item) || button.disabled) return;
        action(); renderOptions();
        [...optionsInner.querySelectorAll('button')].find(candidate => candidate.textContent === label)?.focus();
      });
      return item;
    }
    function renderOptions(): void {
      optionsInner.replaceChildren();
      const mode = doc.createElement('div'); mode.className = 'generator-row';
      mode.append(control(copy('generator.password'), () => { if (generatorOptions.mode === 'password') return; generatorOptions = { mode: 'password', length: GENERATED_PASSWORD_LENGTH, digits: true, symbols: true }; }, generatorOptions.mode === 'password'),
        control(copy('generator.passphrase'), () => { if (generatorOptions.mode === 'passphrase') return; generatorOptions = { mode: 'passphrase', words: PASSPHRASE_DEFAULT_WORDS, separator: '-', capitalize: false, includeNumber: true }; }, generatorOptions.mode === 'passphrase'));
      optionsInner.append(mode);
      const settings = generatorOptions;
      const count = settings.mode === 'password' ? settings.length : settings.words;
      const minimum = settings.mode === 'password' ? PASSWORD_MIN_LENGTH : PASSPHRASE_MIN_WORDS;
      const maximum = settings.mode === 'password' ? PASSWORD_MAX_LENGTH : PASSPHRASE_MAX_WORDS;
      const row = doc.createElement('div'); row.className = 'generator-row';
      const label = doc.createElement('span'); label.className = 'generator-label'; label.textContent = copy(settings.mode === 'password' ? 'generator.length' : 'generator.words');
      const amount = doc.createElement('output'); amount.textContent = String(count); amount.setAttribute('aria-live', 'polite');
      const change = (delta: number) => { generatorOptions = settings.mode === 'password' ? { ...settings, length: count + delta } : { ...settings, words: count + delta }; };
      const less = control('-', () => change(-1)); less.disabled = count <= minimum; less.setAttribute('aria-label', `${label.textContent} -`);
      const more = control('+', () => change(1)); more.disabled = count >= maximum; more.setAttribute('aria-label', `${label.textContent} +`);
      row.append(label, less, amount, more); optionsInner.append(row);
      const toggles = doc.createElement('div'); toggles.className = 'generator-row';
      if (settings.mode === 'password') {
        toggles.append(control(copy('generator.numbers'), () => { generatorOptions = { ...settings, digits: !settings.digits }; }, settings.digits),
          control(copy('generator.symbols'), () => { generatorOptions = { ...settings, symbols: !settings.symbols }; }, settings.symbols));
      } else {
        toggles.append(control(copy('generator.capitalize'), () => { generatorOptions = { ...settings, capitalize: !settings.capitalize }; }, settings.capitalize),
          control(copy('generator.addNumber'), () => { generatorOptions = { ...settings, includeNumber: !settings.includeNumber }; }, settings.includeNumber));
        const separators = doc.createElement('div'); separators.className = 'generator-row'; separators.setAttribute('role', 'group'); separators.setAttribute('aria-label', copy('generator.separator'));
        for (const [separator, key] of [['-', 'generator.hyphen'], ['.', 'generator.dot'], ['_', 'generator.underscore'], [' ', 'generator.space']] as const) {
          separators.append(control(copy(key), () => { generatorOptions = { ...settings, separator }; }, settings.separator === separator));
        }
        optionsInner.append(separators);
      }
      optionsInner.append(toggles);
    }
    renderOptions();
    actions.append(dismiss, button); panel.append(title, status, optionsToggle, optionsBody, actions); current.shadow.append(style, panel);
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

const GENERATOR_STYLES = `
  .generator-title{font-size:13px;font-weight:500;border-bottom:0;padding-bottom:0}
  .status{font-size:12px;padding:8px 14px}
  .generator-control{font:500 12px/1.3 system-ui;cursor:pointer;color:var(--cv-t1);background:transparent;border:1px solid var(--cv-border);border-radius:8px;padding:7px 10px}
  .generator-control:hover{background:var(--cv-hover)}
  .generator-control:focus-visible{outline:2px solid var(--cv-primary);outline-offset:2px}
  .generator-control[aria-pressed=true]{border-color:var(--cv-t2);background:var(--cv-hover)}
  button:disabled{opacity:.5;cursor:default}
  .generator-options-toggle{margin:0 14px 10px}
  .generator-options{display:grid;grid-template-rows:0fr;transition:grid-template-rows 180ms ease}
  .generator-options.expanded{grid-template-rows:1fr}
  .generator-options-inner{overflow:hidden;min-height:0;margin:0 14px}
  .generator-row{display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap}
  .generator-label{flex:1;font-size:12px}.generator-row output{min-width:24px;text-align:center;font-size:12px}
  .generator-footer{display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--cv-border);padding:12px 14px}
  .generator-footer .open-palladin{padding:0 12px}
  @media(prefers-reduced-motion:reduce){.generator-options{transition:none}}
`;
