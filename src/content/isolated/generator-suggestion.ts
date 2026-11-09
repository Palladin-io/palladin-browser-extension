import { CAPTURE_DETECTED_CHANNEL, GENERATOR_PREVIEW_CHANNEL, GENERATOR_SUGGESTIONS_KEY, type GeneratorPreviewResult, type InlineGeneratorOptions } from '@shared/messaging/capture';
import { UI_PREFERENCES_STORAGE_KEY, parseUiPreferences, resolveUiLocale } from '@shared/config/ui-preferences';
import en from '../../popup/locales/en.json';
import pl from '../../popup/locales/pl.json';
import brandLogoUrl from '../../../icons/logo-source.png?inline';
import { createClosedSurface } from './closed-surface';
import type { PasswordCaptureController } from './capture';

export function startGeneratorSuggestion(doc: Document, documentId: string, capture: PasswordCaptureController) {
  let surface: ReturnType<typeof createClosedSurface> | null = null;
  let selected: HTMLInputElement | null = null;
  let panel: HTMLDivElement | null = null;
  let stopped = false, enabled = false, generation = 0;
  let preferences = parseUiPreferences(undefined);
  let revoke: (() => void) | null = null;
  const hide = () => { generation++; revoke?.(); revoke = null; capture.cancelGeneration(); surface?.host.remove(); surface = null; selected = null; panel = null; };
  const copy = (key: keyof typeof en) => (resolveUiLocale(preferences.language, chrome.i18n.getUILanguage()) === 'pl' ? pl : en)[key];
  const reposition = () => {
    if (!surface || !selected || !panel) return;
    const box = selected.getBoundingClientRect();
    const width = doc.defaultView?.innerWidth ?? 368, height = doc.defaultView?.innerHeight ?? 500;
    if (!selected.isConnected || box.width < 40 || box.height < 20 || box.bottom < 0 || box.top > height) { hide(); return; }
    const panelWidth = Math.min(box.width, width - 24);
    const left = Math.max(12, Math.min(box.left, width - panelWidth - 12));
    const launcher = surface.shadow.querySelector<HTMLElement>('.generator-launcher');
    surface.host.style.setProperty('pointer-events', 'auto', 'important');
    if (panel.hidden) {
      surface.host.style.setProperty('left', `${box.right - 36}px`, 'important');
      surface.host.style.setProperty('top', `${box.top}px`, 'important');
      surface.host.style.setProperty('width', '32px', 'important');
      surface.host.style.setProperty('height', `${box.height}px`, 'important');
      if (launcher) launcher.style.top = '50%';
      return;
    }
    surface.host.style.setProperty('width', `${panelWidth}px`, 'important');
    const panelHeight = panel.getBoundingClientRect().height;
    const below = box.bottom - 4;
    const top = below + panelHeight <= height - 8 ? below : box.top - panelHeight >= 8 ? box.top - panelHeight : Math.max(8, height - panelHeight - 8);
    surface.host.style.setProperty('left', `${left}px`, 'important');
    surface.host.style.setProperty('top', `${top}px`, 'important');
    surface.host.style.setProperty('height', `${panelHeight}px`, 'important');
    if (launcher) launcher.style.top = `${box.top + box.height / 2 - top}px`;
  };
  const show = (input: HTMLInputElement) => {
    if (stopped || !enabled || selected === input) return;
    hide();
    const candidate = capture.candidateFor(input);
    if (!candidate) return;
    const candidateId = candidate.id, candidateKind = candidate.kind;
    selected = input;
    surface = createClosedSurface(doc, 'palladin-autofill');
    const current = surface, token = generation;
    current.host.dataset.theme = preferences.theme === 'system'
      ? doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : preferences.theme;
    const style = doc.createElement('style'); style.textContent = GENERATOR_STYLES;
    const card = doc.createElement('div'); card.className = 'generator-panel'; panel = card;
    const heading = doc.createElement('div'); heading.className = 'generator-heading';
    const title = doc.createElement('span'); title.textContent = copy('capture.useStrong'); heading.append(title);
    const valueRow = doc.createElement('div'); valueRow.className = 'generator-value';
    const value = doc.createElement('code'); value.setAttribute('aria-label', copy('generator.generatedValue')); valueRow.append(value);
    const status = doc.createElement('div'); status.className = 'generator-status'; status.setAttribute('role', 'status'); status.hidden = true; valueRow.append(status);
    const optionsBody = doc.createElement('div'); optionsBody.className = 'generator-options'; optionsBody.id = 'generator-options'; optionsBody.inert = true; optionsBody.setAttribute('aria-hidden', 'true');
    const clip = doc.createElement('div'); clip.className = 'generator-options-clip';
    const optionsInner = doc.createElement('div'); optionsInner.className = 'generator-options-content'; clip.append(optionsInner); optionsBody.append(clip);
    let passwordDraft: InlineGeneratorOptions = { mode: 'password', length: 20, digits: true, symbols: true };
    let phraseDraft: InlineGeneratorOptions = { mode: 'passphrase', words: 4, separator: '-', capitalize: false, includeNumber: false };
    let settings: InlineGeneratorOptions = passwordDraft;
    let openedMenu: { menu: HTMLElement; trigger: HTMLButtonElement } | null = null;
    const closeMenu = () => {
      if (!openedMenu) return;
      openedMenu.menu.hidden = true; openedMenu.trigger.setAttribute('aria-expanded', 'false'); openedMenu = null;
    };
    const outsideMenu = (event: Event) => {
      if (event.target === current.host) return;
      if (openedMenu && !event.composedPath().includes(openedMenu.menu) && !event.composedPath().includes(openedMenu.trigger)) closeMenu();
    };
    doc.addEventListener('pointerdown', outsideMenu);
    current.shadow.addEventListener('pointerdown', outsideMenu);
    let preview: Extract<GeneratorPreviewResult, { status: 'preview' }> | null = null;
    let request = 0, menuSequence = 0, busy = false, expiry: ReturnType<typeof setTimeout> | undefined;
    const binding = { channel: GENERATOR_PREVIEW_CHANNEL, documentId, candidateId: candidate.id } as const;
    const active = () => !stopped && token === generation && surface === current;
    const discard = () => {
      request++; clearTimeout(expiry);
      const previewId = preview?.previewId; preview = null; value.textContent = '';
      void chrome.runtime.sendMessage({ ...binding, type: 'dismiss', ...(previewId ? { previewId } : {}) }).catch(() => undefined);
    };
    revoke = () => { closeMenu(); doc.removeEventListener('pointerdown', outsideMenu); discard(); };
    const dismiss = () => { closeMenu(); discard(); card.hidden = true; capture.cancelGeneration(); reposition(); };
    function button(text: string, label: string, className: string, action: () => void): HTMLButtonElement {
      const control = doc.createElement('button'); control.type = 'button'; control.className = className; control.textContent = text;
      if (label) { control.setAttribute('aria-label', label); control.title = label; }
      control.addEventListener('click', event => { if (!control.disabled && current.acceptsAction(event, control)) action(); });
      return control;
    }
    const optionsToggle = button('⚙', copy('generator.inlineOptions'), 'generator-icon', () => {
      closeMenu();
      const open = optionsToggle.getAttribute('aria-expanded') !== 'true';
      optionsToggle.setAttribute('aria-expanded', String(open)); optionsBody.classList.toggle('expanded', open);
      optionsBody.inert = !open; optionsBody.setAttribute('aria-hidden', String(!open)); reposition();
    });
    optionsToggle.setAttribute('aria-expanded', 'false'); optionsToggle.setAttribute('aria-controls', optionsBody.id);
    heading.append(optionsToggle, button('×', copy('generator.inlineClose'), 'generator-icon', dismiss));
    const regenerate = button('↻', copy('generator.inlineRegenerate'), 'generator-icon', () => void refresh()); valueRow.append(regenerate);
    const footer = doc.createElement('div'); footer.className = 'generator-footer';
    const use = button(copy('generator.inlineUse'), '', 'generator-primary', () => {
      if (busy || !preview || capture.candidateFor(input)?.id !== candidate.id) return;
      busy = true; use.disabled = true; regenerate.disabled = true; optionsToggle.disabled = true; optionsBody.inert = true;
      const operationId = crypto.randomUUID(); capture.authorizeGeneration(candidate.id, operationId);
      const previewId = preview.previewId;
      void chrome.runtime.sendMessage({ ...binding, type: 'use', previewId, operationId }).then((result: GeneratorPreviewResult) => {
        if (!active()) return;
        if (result.status === 'filled') { hide(); input.focus(); return; }
        status.textContent = copy('generator.inlineError'); status.hidden = false; preview = null; value.textContent = '';
        busy = false; regenerate.disabled = false; optionsToggle.disabled = false; optionsBody.inert = optionsToggle.getAttribute('aria-expanded') !== 'true';
      }).catch(() => { if (active()) { status.textContent = copy('generator.inlineError'); status.hidden = false; busy = false; regenerate.disabled = false; optionsToggle.disabled = false; optionsBody.inert = optionsToggle.getAttribute('aria-expanded') !== 'true'; } });
    });
    use.disabled = true; footer.append(button(copy('generator.inlineDismiss'), '', 'generator-dismiss', dismiss), use);
    async function refresh(): Promise<void> {
      if (busy || !active()) return;
      const id = ++request; clearTimeout(expiry); preview = null; use.disabled = true; value.textContent = ''; status.hidden = false; status.textContent = copy('generator.inlineLoading');
      reposition();
      try {
        const ack = await chrome.runtime.sendMessage({ channel: CAPTURE_DETECTED_CHANNEL, documentId, candidateId, kind: candidateKind });
        if (!active() || request !== id) return;
        if (!ack?.accepted) { status.textContent = copy('generator.inlinePreviewError'); return; }
        const result: GeneratorPreviewResult = await chrome.runtime.sendMessage({ ...binding, type: 'preview', options: { ...settings } });
        if (!active() || request !== id) return;
        if (result.status !== 'preview') { status.textContent = copy('generator.inlinePreviewError'); return; }
        preview = result; value.textContent = result.value; status.hidden = true; use.disabled = false;
        expiry = setTimeout(() => { if (active()) dismiss(); }, Math.max(0, result.expiresAt - Date.now()));
        reposition();
      } catch { if (active() && request === id) { status.textContent = copy('generator.inlinePreviewError'); status.hidden = false; } }
    }
    function select(label: string, selectedValue: string, choices: readonly { value: string; label: string }[], change: (value: string) => void): HTMLElement {
      const field = doc.createElement('div'); field.className = 'generator-field generator-select';
      const caption = doc.createElement('span'); caption.textContent = label;
      const menu = doc.createElement('div'); menu.className = 'generator-select-menu'; menu.id = `generator-choice-${++menuSequence}`; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', label); menu.hidden = true;
      const trigger = button(choices.find(choice => choice.value === selectedValue)!.label, label, 'generator-select-trigger', () => {
        if (openedMenu?.menu === menu) closeMenu(); else openMenu();
      });
      const chevron = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chevron.setAttribute('viewBox', '0 0 24 24'); chevron.setAttribute('width', '16'); chevron.setAttribute('height', '16'); chevron.setAttribute('aria-hidden', 'true');
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm6 9 6 6 6-6'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '2'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
      chevron.append(path); trigger.append(chevron);
      function openMenu() {
        closeMenu(); menu.hidden = false; openedMenu = { menu, trigger }; trigger.setAttribute('aria-expanded', 'true');
        const box = trigger.getBoundingClientRect(), viewportHeight = doc.defaultView?.innerHeight ?? 500;
        menu.style.width = `${box.width}px`; menu.style.left = `${box.left}px`;
        const height = menu.getBoundingClientRect().height;
        menu.style.top = `${box.bottom + height + 4 <= viewportHeight - 8 ? box.bottom + 4 : Math.max(8, box.top - height - 4)}px`;
      }
      trigger.setAttribute('aria-controls', menu.id); trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
      for (const choice of choices) {
        const option = button(choice.label, '', 'generator-option', () => {
          change(choice.value); renderOptions();
          [...optionsInner.querySelectorAll<HTMLButtonElement>('[role=combobox]')].find(control => control.getAttribute('aria-label') === label)?.focus();
          void refresh();
        });
        option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(choice.value === selectedValue)); menu.append(option);
      }
      trigger.addEventListener('keydown', event => {
        if (!event.isTrusted) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu(); menu.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(); }
      });
      menu.addEventListener('keydown', event => {
        if (!event.isTrusted) return;
        const choices = [...menu.querySelectorAll<HTMLButtonElement>('button')], index = choices.indexOf(current.shadow.activeElement as HTMLButtonElement);
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); trigger.focus(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); choices[(index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length]?.focus(); }
      });
      field.append(caption, trigger); current.shadow.append(menu); return field;
    }
    function renderOptions(): void {
      closeMenu(); current.shadow.querySelectorAll('.generator-select-menu').forEach(menu => menu.remove());
      optionsInner.replaceChildren(select(copy('generator.inlineType'), settings.mode,
        [{ value: 'password', label: copy('generator.password') }, { value: 'passphrase', label: copy('generator.passphrase') }], mode => {
          if (settings.mode === 'password') passwordDraft = settings; else phraseDraft = settings;
          settings = mode === 'password' ? passwordDraft : phraseDraft;
        }));
      if (settings.mode === 'password') {
        const label = doc.createElement('label'); label.className = 'generator-field';
        const caption = doc.createElement('span'); caption.textContent = copy('generator.length');
        const output = doc.createElement('output'); output.textContent = String(settings.length); caption.append(output);
        const range = doc.createElement('input'); range.type = 'range'; range.min = '12'; range.max = '40'; range.value = String(settings.length); range.setAttribute('aria-label', copy('generator.length'));
        range.addEventListener('input', event => { if (event.isTrusted && !busy && settings.mode === 'password') { settings = { ...settings, length: Number(range.value) }; output.textContent = range.value; void refresh(); } });
        label.append(caption, range); optionsInner.append(label);
        const checks = doc.createElement('div'); checks.className = 'generator-checks';
        for (const [key, copyKey] of [['digits', 'generator.numbers'], ['symbols', 'generator.symbols']] as const) {
          const checkbox = button(copy(copyKey), '', 'generator-checkbox', () => { if (settings.mode === 'password') { settings = { ...settings, [key]: !settings[key] }; checkbox.setAttribute('aria-checked', String(settings[key])); void refresh(); } });
          checkbox.setAttribute('aria-label', copy(copyKey)); checkbox.setAttribute('role', 'checkbox'); checkbox.setAttribute('aria-checked', String(settings[key])); checks.append(checkbox);
        }
        optionsInner.append(checks);
      } else {
        optionsInner.append(select(copy('generator.words'), String(settings.words), [3, 4, 5, 6].map(words => ({ value: String(words), label: String(words) })), words => { if (settings.mode === 'passphrase') settings = { ...settings, words: Number(words) }; }),
          select(copy('generator.separator'), settings.separator, [{ value: '-', label: copy('generator.hyphen') }, { value: ' ', label: copy('generator.space') }, { value: '.', label: copy('generator.dot') }], separator => { if (settings.mode === 'passphrase' && (separator === '-' || separator === ' ' || separator === '.')) settings = { ...settings, separator }; }));
      }
    }
    renderOptions();
    const launcher = button('', copy('generator.inlineSuggest'), 'generator-launcher', () => { card.hidden = false; void refresh(); reposition(); });
    const logo = doc.createElement('img'); logo.src = brandLogoUrl; logo.alt = ''; logo.style.pointerEvents = 'none'; launcher.append(logo);
    card.append(heading, valueRow, optionsBody, footer); current.shadow.append(style, launcher, card);
    doc.documentElement.append(current.host); reposition(); void refresh();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(reposition); observer.observe(card);
      const previous = revoke; revoke = () => { observer.disconnect(); previous?.(); };
    }
  };
  const focus = (event: FocusEvent) => { if (event.target === surface?.host) return; if (event.target instanceof HTMLInputElement) show(event.target); else hide(); };
  const input = () => { if (selected?.value) hide(); };
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
  const changes = (values: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(GENERATOR_SUGGESTIONS_KEY in values) && !(UI_PREFERENCES_STORAGE_KEY in values)) return;
    if (GENERATOR_SUGGESTIONS_KEY in values) enabled = values[GENERATOR_SUGGESTIONS_KEY]?.newValue !== false;
    if (UI_PREFERENCES_STORAGE_KEY in values) preferences = parseUiPreferences(values[UI_PREFERENCES_STORAGE_KEY]?.newValue);
    hide();
  };
  doc.addEventListener('focusin', focus); doc.addEventListener('input', input); doc.addEventListener('keydown', key); doc.addEventListener('scroll', reposition, true);
  doc.defaultView?.addEventListener('resize', reposition); chrome.storage.onChanged.addListener(changes);
  const dark = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  const theme = () => { if (surface && preferences.theme === 'system') surface.host.dataset.theme = dark?.matches ? 'dark' : 'light'; };
  dark?.addEventListener('change', theme);
  void chrome.storage.local.get([GENERATOR_SUGGESTIONS_KEY, UI_PREFERENCES_STORAGE_KEY]).then(values => {
    if (stopped) return;
    enabled = values[GENERATOR_SUGGESTIONS_KEY] !== false; preferences = parseUiPreferences(values[UI_PREFERENCES_STORAGE_KEY]);
    if (doc.activeElement instanceof HTMLInputElement) show(doc.activeElement);
  }).catch(() => { enabled = false; hide(); });
  return { isOwnedSurface: (element: Element) => element === surface?.host, hide,
    stop() { stopped = true; hide(); doc.removeEventListener('focusin', focus); doc.removeEventListener('input', input); doc.removeEventListener('keydown', key); doc.removeEventListener('scroll', reposition, true); doc.defaultView?.removeEventListener('resize', reposition); dark?.removeEventListener('change', theme); chrome.storage.onChanged.removeListener(changes); },
  };
}

const GENERATOR_STYLES = `
:host{color-scheme:light;--surface:#fff;--text:#0c0e12;--muted:#5a6478;--line:rgba(12,14,18,.13);--accent:#d43e3e;--wash:#f7f8fa;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
:host([data-theme=dark]){color-scheme:dark;--surface:#191c20;--text:#e8eaed;--muted:#b8c5d4;--line:rgba(232,234,237,.15);--wash:#22262c}
*{box-sizing:border-box}[hidden]{display:none!important}button,input{font:inherit;color:inherit}button{cursor:pointer;min-height:36px;padding:7px 13px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:12px;font-weight:600}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button:disabled{opacity:.5;cursor:default}
.generator-panel{line-height:1.5;position:relative;left:0;width:100%;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);box-shadow:0 6px 20px #00000014;pointer-events:auto;max-height:calc(100vh - 16px);overflow:auto}
.generator-heading{display:flex;align-items:center;padding:8px 12px 0;gap:4px;color:var(--muted);font-size:12px;font-weight:400}.generator-heading>span{flex:1}.generator-icon{border-color:transparent;background:transparent;color:var(--muted);font-weight:600}.generator-heading>.generator-icon{min-height:26px;padding:2px 6px}.generator-value{display:flex;align-items:center;justify-content:space-between;padding:6px 12px 10px;gap:8px}.generator-value code{font-size:12px;overflow-wrap:anywhere;min-width:0}.generator-value code:empty{display:none}.generator-status{min-width:0;font-size:12px;color:var(--muted)}
.generator-footer{border-top:1px solid var(--line);padding:10px 12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.generator-footer button{min-width:0;width:100%}.generator-primary{background:var(--accent);border-color:transparent;color:#fff}.generator-primary:hover{background:color-mix(in srgb,var(--accent) 90%,black)}
.generator-options{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows 240ms ease,opacity 180ms ease}.generator-options.expanded{grid-template-rows:1fr;opacity:1}.generator-options-clip{overflow:hidden;min-height:0}.generator-options-content{padding:12px;border-top:1px solid var(--line)}.generator-field{display:grid;gap:5px;margin-bottom:12px;font-size:12px;font-weight:500}.generator-field>span{color:var(--muted)}.generator-field output{float:right}.generator-field input[type=range]{width:100%;min-height:36px;margin:0;padding:0;accent-color:var(--accent)}
.generator-checks{display:flex;gap:16px}.generator-checkbox{display:flex;align-items:center;gap:8px;min-height:15px;padding:0;border:0;background:transparent;font-size:12px;font-weight:400}.generator-checkbox::before{content:'';width:15px;height:15px;border:1px solid var(--line);border-radius:3px}.generator-checkbox[aria-checked=true]::before{content:'✓';background:var(--accent);color:white;border-color:var(--accent);line-height:13px;text-align:center}
.generator-select{position:relative}.generator-select-trigger{display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;min-height:36px;padding:8px 12px;text-align:left;font-size:13px;font-weight:400}.generator-select-trigger svg{flex:none;color:var(--muted);pointer-events:none}.generator-select-menu{position:fixed;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);pointer-events:auto;z-index:2;background:var(--surface);padding:4px;border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px #0002;max-height:230px;overflow:auto}.generator-option{display:block;width:100%;text-align:left;font-weight:400;padding:8px 12px;border-color:transparent}.generator-option[aria-selected=true]{border-color:var(--text)}.generator-option:hover{background:var(--wash)}
.generator-launcher{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:32px;min-height:30px;padding:5px;border:0;background:transparent;pointer-events:auto}.generator-launcher img{width:21px;height:21px;object-fit:contain;display:block}
@media(prefers-reduced-motion:reduce){.generator-options{transition:none}}
`;
