/** Public open DOM only. Never enters closed roots or another frame. */
export function composedParent(element: Element): Element | null {
  const slot = (element as HTMLElement).assignedSlot;
  if (slot) return slot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

export function queryOpenElements<T extends Element = Element>(root: ParentNode, selector: string): T[] {
  const found: T[] = [];
  if (root instanceof Element && root.shadowRoot) found.push(...queryOpenElements<T>(root.shadowRoot, selector));
  for (const element of root.querySelectorAll('*')) {
    if (element.matches(selector)) found.push(element as T);
    if (element.shadowRoot) found.push(...queryOpenElements<T>(element.shadowRoot, selector));
  }
  return found;
}

/** Bounded public caption, including assigned slot text. Never reads control
 * values or executes website code. Unassigned fallback text follows normal DOM.
 */
export function actionCaption(element: Element): string | null {
  const pending: Node[] = [element];
  let text = '', visited = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++visited > 256) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
      if (text.length > 512) return null;
    } else if (node instanceof Element) {
      if (node.matches('script, style, input, textarea')) continue;
      const assigned = node instanceof HTMLSlotElement ? node.assignedNodes({ flatten: true }) : [];
      const children = assigned.length ? assigned : [...(node.shadowRoot ?? node).childNodes];
      pending.push(...children.reverse());
    }
  }
  return text;
}

/** Native ownership wins, including explicit controls outside the form. For a
 * field in an open component, retain the closest form across its host boundary.
 * An unresolved explicit form attribute must not borrow an ancestor form.
 */
export function composedForm(element: Element): HTMLFormElement | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement
    || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    if (element.form) return element.form;
    if (element.hasAttribute('form')) return null;
  }
  for (let parent: Element | null = element; parent; parent = composedParent(parent)) {
    if (parent instanceof HTMLFormElement) return parent;
  }
  return null;
}
