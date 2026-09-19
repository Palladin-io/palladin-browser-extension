import {
  AGENT_FORM_LIMITS,
  type AgentFormControl,
  type AgentFormInspectMessage,
  type AgentFormInspection,
  type AgentFormObstacle,
} from "@shared/messaging/agent-form";
import { generateNonce } from "@shared/messaging";
import { describeAgentFormControl, isUsableAgentFormControl, type AgentFormElement } from "./agent-form-controls";
import type { AgentInjectDomAccess } from "./agent-inject";

interface BoundControl {
  readonly element: AgentFormElement;
  readonly descriptor: AgentFormControl;
  readonly structuralSignature: string;
}

export class AgentFormRegistry {
  private snapshotId: string | null = null;
  private targetUrl = "";
  private expiresAt = 0;
  private readonly controls = new Map<string, BoundControl>();
  private readonly observers: MutationObserver[] = [];
  private dirty = false;

  constructor(
    private readonly doc: Document,
    private readonly documentId: string,
    private readonly currentUrl: () => string,
    private readonly isTopFrame: () => boolean,
    private readonly dom: AgentInjectDomAccess,
    private readonly now: () => number = Date.now,
    private readonly nonce: () => string = generateNonce,
  ) {}

  inspect(message: AgentFormInspectMessage): AgentFormInspection {
    this.clear();
    if (!this.isTopFrame()) return { outcome: "not-top-frame" };
    if (message.documentId !== this.documentId) return { outcome: "stale-form" };
    if (new URL(this.currentUrl()).protocol !== "https:") return { outcome: "insecure-origin" };
    if (message.targetUrl !== this.currentUrl()) return { outcome: "target-url-mismatch" };
    const obstacles = new Set<AgentFormObstacle>();
    const roots: (Document | ShadowRoot)[] = [this.doc];
    let visited = 0;
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index]!;
      const walker = this.doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node: Node | null;
      while ((node = walker.nextNode()) !== null) {
        visited += 1;
        if (visited > AGENT_FORM_LIMITS.nodes) return this.tooLarge();
        const element = node as Element;
        if (element.shadowRoot !== null) roots.push(element.shadowRoot);
        if (!(element instanceof HTMLElement) || !this.dom.isVisible(element)) continue;
        if (element instanceof HTMLIFrameElement) obstacles.add("embedded-frame");
        if (element.matches('[data-sitekey], [id*="captcha" i], [class*="captcha" i]')) obstacles.add("captcha");
        if (!isUsableAgentFormControl(element, this.dom)) {
          if (element.matches('[contenteditable="true"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"]')) obstacles.add("unsupported-control");
          continue;
        }
        const ref = this.nonce();
        const descriptor = describeAgentFormControl(element, ref);
        if (descriptor.optionCount > AGENT_FORM_LIMITS.nodes) return this.tooLarge();
        this.controls.set(ref, { element, descriptor, structuralSignature: signature(element) });
        if (this.controls.size > AGENT_FORM_LIMITS.controls) return this.tooLarge();
      }
    }
    if (this.controls.size === 0) return { outcome: "no-controls" };
    this.snapshotId = this.nonce();
    this.targetUrl = message.targetUrl;
    this.expiresAt = this.now() + AGENT_FORM_LIMITS.lifetimeMs;
    for (const root of roots) {
      const observer = new MutationObserver(() => { this.dirty = true; });
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      this.observers.push(observer);
    }
    return {
      outcome: "ready",
      snapshot: {
        snapshotId: this.snapshotId,
        documentId: this.documentId,
        controls: [...this.controls.values()].map(({ descriptor }) => descriptor),
        obstacles: [...obstacles],
      },
    };
  }

  resolve(snapshotId: string, ref: string): AgentFormElement | null {
    if (!this.isTopFrame() || this.snapshotId !== snapshotId || this.now() >= this.expiresAt
      || this.currentUrl() !== this.targetUrl || this.dirty
      || this.observers.some((observer) => observer.takeRecords().length !== 0)) {
      this.clear();
      return null;
    }
    const bound = this.controls.get(ref);
    if (bound === undefined || !isUsableAgentFormControl(bound.element, this.dom)
      || signature(bound.element) !== bound.structuralSignature) return null;
    return bound.element;
  }

  clear(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers.length = 0;
    this.controls.clear();
    this.snapshotId = null;
    this.targetUrl = "";
    this.expiresAt = 0;
    this.dirty = false;
  }

  private tooLarge(): AgentFormInspection {
    this.clear();
    return { outcome: "form-too-large" };
  }
}

function signature(element: AgentFormElement): string {
  return JSON.stringify([
    element.tagName, element.getAttribute("type"), element.getAttribute("name"), element.id,
    element.getAttribute("autocomplete"), element.getAttribute("pattern"),
    element.getAttribute("minlength"), element.getAttribute("maxlength"),
    element.getAttribute("required"), element.getAttribute("form"),
    element instanceof HTMLSelectElement ? element.options.length : null,
  ]);
}
