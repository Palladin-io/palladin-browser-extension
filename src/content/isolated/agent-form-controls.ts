import type { AgentFormControl, AgentFormControlKind } from "@shared/messaging/agent-form";
import type { AgentInjectDomAccess } from "./agent-inject";
import { controlPurpose, standardControlKind } from "./form-semantics";
import { isCredentialAction } from './login-controls';

export type AgentFormElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement | HTMLAnchorElement | HTMLDivElement;

export function isAgentFormActionControl(element: Element): element is HTMLButtonElement | HTMLInputElement | HTMLAnchorElement | HTMLDivElement {
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) return ['button', 'submit'].includes(element.type);
  // Use the same bounded action interpretation as user discovery. href-bearing
  // navigation links never become executable controls through this adapter.
  return ((element instanceof HTMLAnchorElement && element.matches('a.button:not([href])'))
    || (element instanceof HTMLDivElement && element.matches('div.btn_primary'))) && isCredentialAction(element);
}

export function agentFormControlKind(element: Element): AgentFormControlKind | null {
  if ((element instanceof HTMLAnchorElement || element instanceof HTMLDivElement) && isAgentFormActionControl(element)) return 'button';
  return standardControlKind(element);
}

export function isUsableAgentFormControl(element: Element, dom: AgentInjectDomAccess): element is AgentFormElement {
  if (agentFormControlKind(element) === null || !(element instanceof HTMLElement)) return false;
  if (element.matches(":disabled") || element.closest('[inert], [hidden], [aria-hidden="true"], [aria-disabled="true"]')) return false;
  if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.readOnly) return false;
  let root: Node = element;
  while (root.getRootNode() instanceof ShadowRoot) {
    const host = (root.getRootNode() as ShadowRoot).host;
    if (host.closest('[inert], [hidden], [aria-hidden="true"], [aria-disabled="true"]')) return false;
    root = host;
  }
  return element.isConnected && dom.isVisible(element);
}

export function describeAgentFormControl(element: AgentFormElement, ref: string): AgentFormControl {
  const kind = agentFormControlKind(element)!;
  const text = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  return {
    ref, kind,
    purpose: controlPurpose(element, kind),
    required: "required" in element && element.required,
    minLength: text && element.minLength >= 0 ? element.minLength : null,
    maxLength: text && element.maxLength >= 0 ? element.maxLength : null,
    hasPattern: element instanceof HTMLInputElement && element.hasAttribute("pattern"),
    optionCount: element instanceof HTMLSelectElement ? element.options.length : 0,
  };
}

