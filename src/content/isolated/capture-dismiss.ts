interface Options {
  button(label: string, className: string, action: () => void | Promise<void>): HTMLButtonElement;
  dismissLabel: string; muteLabel: string; optionsLabel: string; site: string;
  onDismiss(): void | Promise<void>; onMute(): void | Promise<void>;
}

export function createCaptureDismiss(doc: Document, options: Options) {
  const split = doc.createElement('div'); split.className = 'dismiss-split';
  const preference = doc.createElement('div'); preference.className = 'site-preference'; preference.hidden = true;
  const mute = options.button(options.muteLabel, 'site-mute', options.onMute);
  const domain = doc.createElement('small'); domain.textContent = options.site; mute.append(domain); preference.append(mute);
  const toggle = options.button('', 'secondary dismiss-options', () => {
    const open = preference.hidden; preference.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
    if (open) mute.focus();
  });
  toggle.setAttribute('aria-label', options.optionsLabel);
  toggle.setAttribute('aria-expanded', 'false');
  const chevron = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('viewBox', '0 0 24 24'); chevron.setAttribute('aria-hidden', 'true');
  const line = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('d','m6 9 6 6 6-6'); chevron.append(line); toggle.append(chevron);
  const close = () => { preference.hidden = true; toggle.setAttribute('aria-expanded','false'); };
  split.addEventListener('keydown', event => { if (event.key === 'Escape' && !preference.hidden) { event.preventDefault(); event.stopPropagation(); close(); toggle.focus(); } });
  split.addEventListener('focusout', event => { if (!split.contains(event.relatedTarget as Node | null)) close(); });
  split.append(options.button(options.dismissLabel, 'secondary', options.onDismiss), toggle, preference);
  const outside = (event: Event) => {
    const root = split.getRootNode();
    if (!event.composedPath().includes(root instanceof ShadowRoot ? root.host : split)) close();
  };
  doc.addEventListener('pointerdown', outside);
  return { element: split, dispose: () => { close(); doc.removeEventListener('pointerdown', outside); } };
}
