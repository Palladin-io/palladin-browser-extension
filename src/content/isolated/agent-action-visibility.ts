/** Some native actions are translucent hit areas over a separately painted
 * accessible label. This never applies to credential fields or invisible areas. */
export function hasPaintedActionLabel(element: HTMLElement, view: Window): boolean {
  if (!(element instanceof HTMLInputElement) || !['submit', 'button'].includes(element.type)
    || Number.parseFloat(view.getComputedStyle(element).opacity) <= 0) return false;
  const reference = element.getAttribute('aria-labelledby')?.trim();
  const root = element.getRootNode();
  if (!reference || reference.length > 512 || /\s/.test(reference)
    || !(root instanceof Document || root instanceof ShadowRoot)) return false;
  const label = root.getElementById(reference);
  if (!(label instanceof HTMLElement) || label.parentElement !== element.parentElement
    || ![...label.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
    || (typeof label.checkVisibility === 'function' && !label.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))) return false;
  const style = view.getComputedStyle(label);
  if (style.display === 'none' || style.visibility !== 'visible' || Number.parseFloat(style.opacity || '1') <= 0.01) return false;
  const controlRect = element.getBoundingClientRect(), labelRect = label.getBoundingClientRect();
  return (['left', 'top', 'right', 'bottom'] as const).every(edge => Math.abs(controlRect[edge] - labelRect[edge]) <= 1);
}
