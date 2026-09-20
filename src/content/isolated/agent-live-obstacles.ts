import type { AgentInjectDomAccess } from './agent-inject';
import { isUsableAgentFormControl } from './agent-form-controls';
import { composedParent, queryOpenElements } from './open-dom';

const CAPTCHA = '[data-sitekey], [id*="captcha" i], [class*="captcha" i]';
const CUSTOM = '[contenteditable="true"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"]';

/** A complete native login need not operate every widget in its document.
 * This policy is live-login-only; the registry retains its strict global report.
 * Frames are never entered. Explicit challenges remain blocking, including a
 * challenge outside the form; normal frame contents make no safety claim.
 */
export function hasLiveLoginObstacle(doc: Document, scope: HTMLElement, dom: AgentInjectDomAccess): boolean {
  // The registry has already bounded this document/open-shadow scan.
  return queryOpenElements<HTMLElement>(doc, `${CAPTCHA}, ${CUSTOM}, iframe`).some(element => {
    if (!dom.isVisible(element)) return false;
    if (element.matches(CAPTCHA)) return true;
    if (element instanceof HTMLIFrameElement) {
      return /captcha|challenge/i.test(`${element.getAttribute('title') ?? ''} ${element.getAttribute('aria-label') ?? ''}`);
    }
    if (isUsableAgentFormControl(element, dom)) return false;
    for (let ancestor: Element | null = element; ancestor; ancestor = composedParent(ancestor)) {
      if (ancestor === scope) return true;
    }
    return false;
  });
}
