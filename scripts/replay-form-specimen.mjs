/** Test-only traversal: production controls must use their own discovery path. */
export function querySpecimen(root, selector) {
  const matches = [];
  for (const child of root.children) {
    if (child.matches(selector)) matches.push(child);
    matches.push(...querySpecimen(child, selector));
    if (child.shadowRoot) matches.push(...querySpecimen(child.shadowRoot, selector));
  }
  return matches;
}

/** Restore observed public open-root boundaries without website scripts or values. */
export function hydrateFormSpecimen(root, css) {
  for (const template of root.querySelectorAll('template[data-form-specimen-shadow="open"]')) {
    const host = template.parentElement;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(template.content);
    template.remove();
    const style = host.ownerDocument.createElement('style');
    style.textContent = css;
    shadow.append(style);
    hydrateFormSpecimen(shadow, css);
  }
}

/** Test-only reproduction of a separately observed public input response. */
export function installFormActionActivation(root, activation) {
  if (!activation) return;
  if (activation.kind !== 'nonempty-fields') throw new Error('Unknown observed action activation');
  const action = querySpecimen(root, activation.action)[0];
  const fields = activation.fields.map(selector => querySpecimen(root, selector)[0]);
  if (!action || fields.some(field => !field)) throw new Error('Missing observed activation controls');
  const update = () => {
    const disabled = fields.some(field => field.value === '');
    if (action.classList.contains(activation.disabledClass) !== disabled) action.classList.toggle(activation.disabledClass, disabled);
    const opacity = disabled ? activation.opacity.disabled : activation.opacity.enabled;
    if (action.style.opacity !== opacity) action.style.opacity = opacity;
  };
  for (const field of fields) field.addEventListener('input', update);
  update();
}
