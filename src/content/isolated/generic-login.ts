import { isFillable, type LoginTarget } from "./credential-form-analysis";
import { isIdentifiedUsername, isRegistrationScope } from "./login-controls";
import { autocompleteTokens as tokens } from "./form-semantics";
import { composedParent, composedForm, queryOpenElements } from "./open-dom";

const USERNAME_TYPES = new Set(["text", "email", "tel"]);
function isUsername(input: HTMLInputElement): boolean {
  if (!USERNAME_TYPES.has(input.type)) return false;
  const autocomplete = tokens(input).filter(token => token !== "" && !token.startsWith("section-") && token !== "webauthn");
  // Explicit non-login semantics override weak name/label hints.
  if (autocomplete.some(token => !["username", "email", "on", "off"].includes(token))) return false;
  return isIdentifiedUsername(input);
}

function isBoundary(element: Element): boolean {
  return element.matches('form, [role="form"], dialog, [role="dialog"], section, article')
    || element.localName.endsWith("-form");
}

function boundaryFor(input: HTMLInputElement): Element | null {
  for (let parent = composedParent(input); parent !== null; parent = composedParent(parent)) {
    if (isBoundary(parent)) return parent;
  }
  return null;
}

export function genericLoginTargetFor(input: HTMLInputElement): LoginTarget | null {
  if (input.ownerDocument.location.protocol !== "https:" || composedForm(input) !== null || input.hasAttribute("form") || !isUsername(input)) return null;
  const boundary = boundaryFor(input);
  for (let container = composedParent(input); container !== null; container = composedParent(container)) {
    // The whole page is not evidence that two controls belong to one login.
    if (container.matches("body, html, main")) return null;
    if (!(container instanceof HTMLElement)) continue;
    const controls = queryOpenElements<HTMLInputElement>(container, "input").filter(isFillable);
    const passwords = controls.filter(control => control.type === "password");
    if (passwords.length > 0) {
      const usernames = controls.filter(control => USERNAME_TYPES.has(control.type));
      const password = passwords[0]!;
      if (isRegistrationScope(container, controls) || passwords.length !== 1 || usernames.length !== 1 || usernames[0] !== input
        || composedForm(password) !== null || password.hasAttribute("form") || boundaryFor(password) !== boundary
        || tokens(input).find(token => token.startsWith("section-"))
          !== tokens(password).find(token => token.startsWith("section-"))
        || tokens(password).some(token => token !== "" && token !== "current-password" && token !== "on"
          && token !== "off" && !token.startsWith("section-"))) return null;
      return { sourceDocument: input.ownerDocument, username: input, password, form: container };
    }
    if (container === boundary) return null;
  }
  return null;
}
