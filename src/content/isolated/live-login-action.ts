import { hasLoginActionLabel } from './login-controls';

export type LiveLoginAction = HTMLButtonElement | HTMLInputElement | HTMLAnchorElement | HTMLDivElement;

export function isNativeLoginAction(element: Element): element is HTMLButtonElement | HTMLInputElement {
  return (element instanceof HTMLButtonElement || element instanceof HTMLInputElement)
    && ['button', 'submit'].includes(element.type);
}

/** Only observed non-navigating action shapes, never arbitrary clickable text. */
export function isCustomLoginAction(element: Element): element is HTMLAnchorElement | HTMLDivElement {
  return ((element instanceof HTMLAnchorElement && element.matches('a.button:not([href])'))
    || (element instanceof HTMLDivElement && element.matches('div.btn_primary')))
    && hasLoginActionLabel(element);
}

export const LIVE_ACTION_SELECTOR = 'button,input[type="submit"],input[type="button"],a.button:not([href]),div.btn_primary';
