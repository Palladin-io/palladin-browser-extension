/**
 * Isolated-world DOM selection and the final pre-write gates for user autofill.
 * Popup/side-panel requests arrive after their own extension-surface checks.
 * Inline requests additionally carry a one-use capability bound to the exact
 * controls selected while handling a direct user gesture.
 */

import type { FillField, FillOutcome, FillRequestMessage } from "@shared/messaging";
import { matchesTab } from "@shared/security/domain";

type TextLikeInput = HTMLInputElement;
type FillControl = HTMLInputElement | HTMLTextAreaElement;

const USERNAME_TYPES = new Set(["text", "email", "tel", ""]);
const CARD_AUTOCOMPLETE_KIND: Readonly<Record<string, FillField["kind"]>> = {
  "cc-name": "cardholder",
  "cc-number": "card-number",
  "cc-exp-month": "card-expiry-month",
  "cc-exp-year": "card-expiry-year",
  "cc-exp": "card-expiry",
};
const MAX_VISUAL_INTEGRITY_ELEMENTS = 10_000;
const EXTENSION_AUTOFILL_HOSTS = new WeakMap<HTMLElement, HTMLInputElement>();

/** Register only hosts created by this isolated-world runtime. */
export function registerExtensionAutofillHost(
  host: HTMLElement,
  input: HTMLInputElement,
): void {
  EXTENSION_AUTOFILL_HOSTS.set(host, input);
}

export function unregisterExtensionAutofillHost(host: HTMLElement): void {
  EXTENSION_AUTOFILL_HOSTS.delete(host);
}

/** Exact host-to-input geometry and paint binding shared by every fill gate. */
export function isExtensionAutofillHostAnchored(
  host: HTMLElement,
  input: HTMLInputElement,
): boolean {
  const doc = host.ownerDocument;
  const view = doc.defaultView;
  if (view === null
    || input.ownerDocument !== doc
    || !host.isConnected
    || !input.isConnected) return false;
  const requiredInline = [
    ["font-family", 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'],
    ["font-size", "16px"],
    ["line-height", "1.4"],
    ["font-synthesis", "none"],
    ["position", "fixed"],
    ["z-index", "2147483647"],
    ["width", "26px"],
    ["height", "26px"],
    ["display", "block"],
  ] as const;
  // Do not use `getPropertyValue("all")` as proof. Real Chromium serializes
  // that shorthand as an empty string after later longhands are assigned.
  const allowedInlineProperties = new Set([
    "all",
    "left",
    "top",
    // Chromium exposes `font-synthesis: none` through style.item() as these
    // longhands even though getPropertyValue("font-synthesis") still returns
    // the exact shorthand value checked below.
    "font-synthesis-weight",
    "font-synthesis-style",
    "font-synthesis-small-caps",
    "font-synthesis-position",
    ...requiredInline.map(([property]) => property),
  ]);
  const inlineProperties = Array.from(
    { length: host.style.length },
    (_value, index) => host.style.item(index),
  );
  if (inlineProperties.some((property) => !allowedInlineProperties.has(property))
    || requiredInline.some(([property, value]) => host.style.getPropertyValue(property) !== value
    || host.style.getPropertyPriority(property) !== "important")) return false;

  const inputRect = input.getBoundingClientRect();
  if (!validRect(inputRect) || inputRect.width < 40 || inputRect.height < 20) return false;
  const edgeGap = Math.min(18, Math.max(8, (inputRect.height - 26) / 2));
  const expectedLeft = Math.max(4, inputRect.right - 26 - edgeGap);
  const expectedTop = Math.max(4, inputRect.top + (inputRect.height - 26) / 2);
  if (host.style.getPropertyValue("left") !== `${expectedLeft}px`
    || host.style.getPropertyPriority("left") !== "important"
    || host.style.getPropertyValue("top") !== `${expectedTop}px`
    || host.style.getPropertyPriority("top") !== "important") return false;
  const hostRect = host.getBoundingClientRect();
  if (!validRect(hostRect)
    || Math.abs(hostRect.left - expectedLeft) > 0.75
    || Math.abs(hostRect.top - expectedTop) > 0.75
    || Math.abs(hostRect.width - 26) > 0.75
    || Math.abs(hostRect.height - 26) > 0.75) return false;

  const style = view.getComputedStyle(host);
  return style.display !== "none"
    && style.position === "fixed"
    && style.zIndex === "2147483647"
    && style.visibility !== "hidden"
    && style.visibility !== "collapse"
    && style.pointerEvents !== "none"
    && computedOpacity(style) === 1
    && !hasUnverifiablePaintEffect(style)
    && !hasOutboundPaint(style)
    && nonDefaultEffect(style.getPropertyValue("transform"), "none") === false
    && !hasNonTransparentColor(style.backgroundColor)
    && nonDefaultEffect(style.backgroundImage, "none") === false
    && nonDefaultEffect(style.boxShadow, "none") === false
    && !hasPaintedPseudoEdge(style);
}

/**
 * Last-mile DOM-write gate. Page markup is hostile: visibility must come from
 * computed layout, not only from inline attributes, and every ancestor can hide
 * or disable interaction with an otherwise ordinary-looking control.
 */
function isFillable(input: FillControl): boolean {
  if (input.disabled || input.matches(":disabled") || input.readOnly) return false;
  if (input.hidden || (input instanceof HTMLInputElement && input.type === "hidden")) return false;
  if (input.getAttribute("aria-hidden") === "true") return false;
  const doc = input.ownerDocument;
  const view = doc.defaultView;
  if (view === null || !input.isConnected || typeof doc.elementFromPoint !== "function") return false;

  if (typeof input.checkVisibility === "function" && !input.checkVisibility({
    checkOpacity: true,
    checkVisibilityCSS: true,
  })) return false;

  for (let current: HTMLElement | null = input; current !== null; current = current.parentElement) {
    if (current.hidden
      || current.hasAttribute("inert")
      || current.inert
      || current.getAttribute("aria-hidden") === "true") return false;
    const style = view.getComputedStyle(current);
    if (style.display === "none"
      || style.visibility === "hidden"
      || style.visibility === "collapse"
      || style.contentVisibility === "hidden"
      || style.pointerEvents === "none"
      || computedOpacity(style) < 1
      || hasUnverifiablePaintEffect(style)) {
      return false;
    }
  }
  if (!hasVisibleControlPaint(view.getComputedStyle(input))) return false;

  const rect = input.getBoundingClientRect();
  const viewportWidth = view.innerWidth || doc.documentElement.clientWidth;
  const viewportHeight = view.innerHeight || doc.documentElement.clientHeight;
  if (!validRect(rect) || viewportWidth <= 0 || viewportHeight <= 0) return false;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  if (centerX < 0 || centerY < 0 || centerX > viewportWidth || centerY > viewportHeight) {
    return false;
  }
  if (!isTargetVisuallyClearAtPoint(input, centerX, centerY)) return false;

  // A control whose center is clipped by an overflow ancestor is not a visible
  // target, even when its own rectangle happens to intersect the viewport.
  for (let current = input.parentElement; current !== null; current = current.parentElement) {
    const style = view.getComputedStyle(current);
    const clipsX = style.overflowX === "hidden" || style.overflowX === "clip"
      || style.overflowX === "auto" || style.overflowX === "scroll";
    const clipsY = style.overflowY === "hidden" || style.overflowY === "clip"
      || style.overflowY === "auto" || style.overflowY === "scroll";
    if (!clipsX && !clipsY) continue;
    const ancestorRect = current.getBoundingClientRect();
    if (!validRect(ancestorRect)) return false;
    if ((clipsX && (centerX < ancestorRect.left || centerX > ancestorRect.right))
      || (clipsY && (centerY < ancestorRect.top || centerY > ancestorRect.bottom))) {
      return false;
    }
  }
  return true;
}

function validRect(rect: DOMRect): boolean {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.right)
    && Number.isFinite(rect.bottom)
    && rect.width > 0
    && rect.height > 0;
}

/**
 * Fail-closed paint/hit-test proof for one sampled point. `elementFromPoint`
 * covers normal border-box occluders. The additional bounded scan catches
 * outbound paint such as outlines and shadows, which browser hit testing does
 * not include even when the painted element accepts pointer events.
 */
export function isTargetVisuallyClearAtPoint(
  target: HTMLElement,
  x: number,
  y: number,
): boolean {
  const doc = target.ownerDocument;
  const view = doc.defaultView;
  if (view === null || typeof doc.elementFromPoint !== "function") return false;
  try {
    const hit = doc.elementFromPoint(x, y);
    if (hit === null || (hit !== target && !target.contains(hit))) return false;

    let inspected = 0;
    for (const candidate of elementsIncludingOpenShadow(doc)) {
      inspected += 1;
      if (inspected > MAX_VISUAL_INTEGRITY_ELEMENTS) return false;
      const extensionInput = extensionHostInput(candidate);
      if (extensionInput !== null) {
        if (isNonPaintingHiddenExtensionHost(candidate)) continue;
        if (!isExtensionAutofillHostAnchored(candidate, extensionInput)
          || hasGeneratedPaint(view, candidate)) return false;
        continue;
      }
      // Production surfaces are closed. Tests expose them as open so their
      // controls can be exercised; their internal, extension-owned paint is
      // not page paint and the registered host itself was validated above.
      if (belongsToRegisteredExtensionSurface(candidate)) continue;
      const candidateStyle = view.getComputedStyle(candidate);
      if (hasAmbiguousPseudoOverlay(view, candidate, target, x, y)) return false;
      if (candidate === target) {
        // Hostile page CSS on the exact control can paint over the surrounding
        // form while elementFromPoint still reports that control. Only the
        // browser's bounded focus ring on the active control is allowed.
        if (hasOutboundPaint(candidateStyle, candidate === doc.activeElement)) return false;
        continue;
      }
      // Outlines and shadows can paint far outside the border box without
      // participating in hit testing. Pointer-events:auto is not proof: when
      // only the outbound paint reaches this point, elementFromPoint still
      // reports the underlying field. Inspect every bounded candidate before
      // relationship and rectangle shortcuts.
      if (hasOutboundPaint(candidateStyle, candidate === doc.activeElement)) return false;
      if (candidate.contains(target) || target.contains(candidate)) continue;
      const rect = candidate.getBoundingClientRect();
      // A normal topmost element was already handled by elementFromPoint. Any
      // additional geometric overlap is nevertheless ambiguous: it may be
      // pointer-transparent, behind the input, or a shadow host whose closed
      // tree cannot be traversed. Fail closed instead of guessing paint order.
      if (validRect(rect)
        && x >= rect.left && x <= rect.right
        && y >= rect.top && y <= rect.bottom) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Paint-integrity scan for a point inside Palladin's closed surface. Normal
 * hit-testing is performed by the caller because the document sees only the
 * shadow host. This additional scan catches page paint outside normal hit-test
 * geometry, including generated content and open shadow descendants, while
 * allowing the bound input and its layout ancestors underneath the extension
 * surface.
 */
export function isExtensionSurfaceVisuallyClearAtPoint(
  surfaceHost: HTMLElement,
  boundInput: HTMLInputElement,
  x: number,
  y: number,
): boolean {
  const doc = surfaceHost.ownerDocument;
  const view = doc.defaultView;
  if (view === null
    || boundInput.ownerDocument !== doc
    || !surfaceHost.isConnected
    || !boundInput.isConnected) return false;
  try {
    let inspected = 0;
    for (const candidate of elementsIncludingOpenShadow(doc)) {
      inspected += 1;
      if (inspected > MAX_VISUAL_INTEGRITY_ELEMENTS) return false;
      const extensionInput = extensionHostInput(candidate);
      if (candidate === surfaceHost) {
        if (!isExtensionAutofillHostAnchored(surfaceHost, boundInput)
          || hasGeneratedPaint(view, surfaceHost)) return false;
        continue;
      }
      if (belongsToSurfaceShadow(candidate, surfaceHost)) continue;
      if (belongsToRegisteredExtensionSurface(candidate)) continue;
      if (extensionInput !== null) {
        if (isNonPaintingHiddenExtensionHost(candidate)) continue;
        if (!isExtensionAutofillHostAnchored(candidate, extensionInput)
          || hasGeneratedPaint(view, candidate)) return false;
        continue;
      }
      const candidateStyle = view.getComputedStyle(candidate);
      if (hasAmbiguousPseudoOverlay(view, candidate, boundInput, x, y)) return false;
      if (candidate === boundInput) {
        if (hasOutboundPaint(candidateStyle, candidate === doc.activeElement)) return false;
        continue;
      }
      if (hasOutboundPaint(candidateStyle)) return false;
      if (candidate.contains(boundInput)
        || boundInput.contains(candidate)) continue;
      const rect = candidate.getBoundingClientRect();
      if (validRect(rect)
        && x >= rect.left && x <= rect.right
        && y >= rect.top && y <= rect.bottom) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function* elementsIncludingOpenShadow(doc: Document): Generator<HTMLElement> {
  const roots: Array<Document | ShadowRoot> = [doc];
  while (roots.length > 0) {
    const root = roots.shift();
    if (root === undefined) return;
    for (const element of root.querySelectorAll<HTMLElement>("*")) {
      yield element;
      if (element.shadowRoot !== null) roots.push(element.shadowRoot);
    }
  }
}

function isExtensionAutofillHost(element: Element): boolean {
  return element instanceof HTMLElement && EXTENSION_AUTOFILL_HOSTS.has(element);
}

function extensionHostInput(element: HTMLElement): HTMLInputElement | null {
  return EXTENSION_AUTOFILL_HOSTS.get(element) ?? null;
}

function isNonPaintingHiddenExtensionHost(host: HTMLElement): boolean {
  const view = host.ownerDocument.defaultView;
  return view !== null
    && host.style.getPropertyValue("display") === "none"
    && host.style.getPropertyPriority("display") === "important"
    && view.getComputedStyle(host).display === "none";
}

function belongsToRegisteredExtensionSurface(element: Element): boolean {
  const root = element.getRootNode();
  return root instanceof ShadowRoot
    && root.host instanceof HTMLElement
    && extensionHostInput(root.host) !== null;
}

function belongsToSurfaceShadow(element: Element, host: HTMLElement): boolean {
  const root = element.getRootNode();
  return root instanceof ShadowRoot && root.host === host;
}

function hasAmbiguousPseudoOverlay(
  view: Window,
  origin: HTMLElement,
  target: HTMLElement,
  x: number,
  y: number,
): boolean {
  for (const pseudo of ["::before", "::after"] as const) {
    const style = view.getComputedStyle(origin, pseudo);
    if (!pseudoPaints(style)) continue;
    if (hasOutboundPaint(style)) return true;
    if (origin === target || origin.contains(target)) return true;
    const rect = origin.getBoundingClientRect();
    if (validRect(rect)
      && x >= rect.left && x <= rect.right
      && y >= rect.top && y <= rect.bottom) return true;
    // CSSOM exposes computed pseudo styles but no pseudo-element layout box.
    // Positioned generated paint can escape the originating element, so its
    // absence at this point cannot be proven without pixel/paint-tree access.
    if (style.position === "fixed"
      || style.position === "absolute"
      || style.position === "sticky") return true;
  }
  return false;
}

function hasGeneratedPaint(view: Window, origin: HTMLElement): boolean {
  return (["::before", "::after"] as const)
    .some((pseudo) => pseudoPaints(view.getComputedStyle(origin, pseudo)));
}

function pseudoPaints(style: CSSStyleDeclaration): boolean {
  const content = style.content.trim().toLowerCase();
  if (content === "" || content === "none" || content === "normal") return false;
  if (style.display === "none"
    || style.visibility === "hidden"
    || style.visibility === "collapse"
    || computedOpacity(style) <= 0) return false;
  if (hasNonTransparentColor(style.backgroundColor)) return true;
  if (style.backgroundImage !== "" && style.backgroundImage !== "none") return true;
  if (style.boxShadow !== "" && style.boxShadow !== "none") return true;
  if (hasOutboundPaint(style)) return true;
  if (hasPaintedPseudoEdge(style)) return true;
  const literal = content.match(/^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')$/);
  // A URL/image, counter, quote token, attr(), or any mixed generated-content
  // value is not safely classifiable as transparent text. Treat it as paint;
  // image content in particular remains visible when `color` is transparent.
  if (literal === null) return true;
  const unquoted = (literal[1] ?? literal[2] ?? "").trim();
  return unquoted.length > 0 && hasNonTransparentColor(style.color);
}

function hasPaintedPseudoEdge(style: CSSStyleDeclaration): boolean {
  return (["Top", "Right", "Bottom", "Left"] as const).some((side) => {
    const width = style[`border${side}Width`];
    const lineStyle = style[`border${side}Style`];
    const color = style[`border${side}Color`];
    return lineStyle !== "none"
      && lineStyle !== "hidden"
      && Number.parseFloat(width || "0") > 0
      && hasNonTransparentColor(color);
  });
}

function computedOpacity(style: CSSStyleDeclaration): number {
  const value = Number.parseFloat(style.opacity || "1");
  return Number.isFinite(value) ? value : 0;
}

function hasUnverifiablePaintEffect(style: CSSStyleDeclaration): boolean {
  return nonDefaultEffect(style.getPropertyValue("filter"), "none")
    || nonDefaultEffect(style.getPropertyValue("-webkit-filter"), "none")
    || nonDefaultEffect(style.getPropertyValue("backdrop-filter"), "none")
    || nonDefaultEffect(style.getPropertyValue("-webkit-backdrop-filter"), "none")
    || nonDefaultEffect(style.getPropertyValue("clip-path"), "none")
    || nonDefaultEffect(style.getPropertyValue("-webkit-clip-path"), "none")
    || nonDefaultEffect(style.getPropertyValue("mask-image"), "none")
    || nonDefaultEffect(style.getPropertyValue("-webkit-mask-image"), "none")
    || nonDefaultEffect(style.getPropertyValue("mix-blend-mode"), "normal")
    || nonDefaultEffect(style.getPropertyValue("clip"), "auto");
}

function hasOutboundPaint(
  style: CSSStyleDeclaration,
  allowBoundedNativeFocusOutline = false,
): boolean {
  const outlineStyle = style.getPropertyValue("outline-style").trim().toLowerCase();
  const outlineWidth = Number.parseFloat(style.getPropertyValue("outline-width") || "0");
  const outlineShorthand = style.getPropertyValue("outline").trim().toLowerCase();
  const serializedOutlineWidth = Number.parseFloat(
    outlineShorthand.match(/(?:^|\s)([\d.]+)px(?:\s|$)/)?.[1] ?? "0",
  );
  const outlineOffset = Number.parseFloat(style.getPropertyValue("outline-offset") || "0");
  const isBoundedNativeFocusOutline = allowBoundedNativeFocusOutline
    && (outlineStyle === "auto" || /(?:^|\s)auto(?:\s|$)/.test(outlineShorthand))
    && Math.max(outlineWidth, serializedOutlineWidth) <= 5
    && Math.abs(Number.isFinite(outlineOffset) ? outlineOffset : 0) <= 2;
  const hasOutline = outlineStyle !== ""
    && outlineStyle !== "none"
    && outlineStyle !== "hidden"
    && outlineWidth > 0
    && hasNonTransparentColor(style.getPropertyValue("outline-color"))
    && !isBoundedNativeFocusOutline;
  const hasSerializedOutline = outlineShorthand !== ""
    && outlineShorthand !== "none"
    && !/(?:^|\s)(?:none|hidden)(?:\s|$)/.test(outlineShorthand)
    && !/(?:^|\s)0(?:px|em|rem|pt)?(?:\s|$)/.test(outlineShorthand)
    && !isBoundedNativeFocusOutline;
  const borderImageSource = style.getPropertyValue("border-image-source").trim().toLowerCase();
  const textDecoration = style.getPropertyValue("text-decoration-line").trim().toLowerCase();
  return hasOutline
    || hasSerializedOutline
    || nonDefaultEffect(style.getPropertyValue("box-shadow"), "none")
    || nonDefaultEffect(style.getPropertyValue("text-shadow"), "none")
    || nonDefaultEffect(style.getPropertyValue("filter"), "none")
    || nonDefaultEffect(style.getPropertyValue("-webkit-filter"), "none")
    || nonDefaultEffect(style.getPropertyValue("backdrop-filter"), "none")
    || nonDefaultEffect(style.getPropertyValue("-webkit-backdrop-filter"), "none")
    || (borderImageSource !== "" && borderImageSource !== "none")
    || Number.parseFloat(style.getPropertyValue("-webkit-text-stroke-width") || "0") > 0
    || (textDecoration !== "" && textDecoration !== "none")
    || nonDefaultEffect(style.getPropertyValue("-webkit-box-reflect"), "none");
}

function nonDefaultEffect(value: string, expected: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== expected;
}

function hasVisibleControlPaint(style: CSSStyleDeclaration): boolean {
  if (hasOpaqueColor(style.backgroundColor)) return true;
  return (["Top", "Right", "Bottom", "Left"] as const).some((side) => {
    const width = style[`border${side}Width`];
    const lineStyle = style[`border${side}Style`];
    const color = style[`border${side}Color`];
    return lineStyle !== "none"
      && lineStyle !== "hidden"
      && Number.parseFloat(width || "0") > 0
      && hasOpaqueColor(color);
  });
}

function hasOpaqueColor(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "transparent") return false;
  const commaAlpha = normalized.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+%?)\)$/);
  if (commaAlpha !== null) return parseCssAlpha(commaAlpha[1] ?? "0") === 1;
  const slashAlpha = normalized.match(/\/\s*([\d.]+%?)\s*\)$/);
  return slashAlpha === null || parseCssAlpha(slashAlpha[1] ?? "0") === 1;
}

function hasNonTransparentColor(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "transparent") return false;
  const commaAlpha = normalized.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+%?)\)$/);
  if (commaAlpha !== null) return parseCssAlpha(commaAlpha[1] ?? "0") > 0;
  const slashAlpha = normalized.match(/\/\s*([\d.]+%?)\s*\)$/);
  return slashAlpha === null || parseCssAlpha(slashAlpha[1] ?? "0") > 0;
}

function parseCssAlpha(value: string): number {
  const numeric = Number.parseFloat(value);
  return value.endsWith("%") ? numeric / 100 : numeric;
}

function isVisibleForm(form: HTMLFormElement | null): form is HTMLFormElement {
  if (form === null || !form.isConnected || form.hidden || form.getAttribute("aria-hidden") === "true") {
    return false;
  }
  const view = form.ownerDocument.defaultView;
  if (view === null) return false;
  for (let current: HTMLElement | null = form; current !== null; current = current.parentElement) {
    if (current.hidden
      || current.hasAttribute("inert")
      || current.inert
      || current.getAttribute("aria-hidden") === "true") return false;
    const style = view.getComputedStyle(current);
    if (style.display === "none"
      || style.visibility === "hidden"
      || style.visibility === "collapse"
      || style.contentVisibility === "hidden"
      || computedOpacity(style) < 1
      || hasUnverifiablePaintEffect(style)) {
      return false;
    }
  }
  return true;
}

interface ControlSnapshot {
  readonly value: string;
  readonly type: string;
  readonly name: string;
  readonly autocomplete: string;
}

interface FormSnapshot {
  readonly action: string;
  readonly method: string;
  readonly target: string;
  readonly enctype: string;
  readonly noValidate: boolean;
}

interface InlineFillCapability {
  readonly id: string;
  readonly generation: number;
  readonly doc: Document;
  readonly username: HTMLInputElement;
  readonly password: HTMLInputElement;
  readonly form: HTMLFormElement;
  readonly usernameState: ControlSnapshot;
  readonly passwordState: ControlSnapshot;
  readonly formState: FormSnapshot;
}

/**
 * One pending inline capability per document. It is consumed before any
 * validation or write, so a worker retry/replay always fails closed.
 */
export class OneShotInlineFillCapabilities {
  private generation = 0;
  private pending: InlineFillCapability | null = null;
  private mutationObserver: MutationObserver | null = null;
  private trackedDocument: Document | null = null;

  noteDomMutation(): void {
    this.generation += 1;
  }

  issue(input: HTMLInputElement): string | null {
    this.stopTracking();
    const target = resolveInlineTarget(input);
    this.pending = null;
    if (target === null) return null;
    const id = createCapabilityId(input.ownerDocument);
    if (id === null) return null;
    if (!this.startTracking(input.ownerDocument)) return null;
    this.pending = {
      id,
      generation: this.generation,
      doc: input.ownerDocument,
      ...target,
      usernameState: snapshotControl(target.username),
      passwordState: snapshotControl(target.password),
      formState: snapshotForm(target.form),
    };
    return id;
  }

  consume(id: string): InlineFillCapability | null {
    this.flushMutationRecords();
    const capability = this.pending;
    this.pending = null;
    const valid = capability !== null
      && capability.id === id
      && capability.generation === this.generation;
    if (!valid) this.stopTracking();
    return valid ? capability : null;
  }

  generationMatches(capability: InlineFillCapability): boolean {
    this.flushMutationRecords();
    return this.trackedDocument === capability.doc
      && capability.generation === this.generation;
  }

  complete(capability: InlineFillCapability): void {
    if (this.trackedDocument === capability.doc) this.stopTracking();
  }

  revoke(id: string): void {
    if (this.pending?.id !== id) return;
    this.pending = null;
    this.stopTracking();
  }

  clear(): void {
    this.pending = null;
    this.stopTracking();
  }

  private startTracking(doc: Document): boolean {
    const view = doc.defaultView;
    if (view === null || doc.documentElement === null) return false;
    this.trackedDocument = doc;
    this.mutationObserver = new view.MutationObserver((records) => this.recordMutations(records));
    this.mutationObserver.observe(doc.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    return true;
  }

  private flushMutationRecords(): void {
    const records = this.mutationObserver?.takeRecords() ?? [];
    this.recordMutations(records);
  }

  private recordMutations(records: readonly MutationRecord[]): void {
    if (records.some(isPageMutation)) this.generation += 1;
  }

  private stopTracking(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.trackedDocument = null;
  }
}

function isPageMutation(record: MutationRecord): boolean {
  // The document observer cannot see legitimate rendering inside our closed
  // shadow root. The only document-tree update allowed while a capability is
  // pending is the presentation-only theme marker written by the isolated
  // runtime. Page rewrites of style, light-DOM children, or any other state
  // still invalidate the snapshot.
  if (record.type === "attributes"
    && record.attributeName === "data-theme"
    && record.target instanceof Element
    && isExtensionAutofillHost(record.target)) return false;
  return record.type === "attributes" || record.type === "childList" || record.type === "characterData";
}

function resolveInlineTarget(input: HTMLInputElement): {
  readonly username: HTMLInputElement;
  readonly password: HTMLInputElement;
  readonly form: HTMLFormElement;
} | null {
  const form = input.form;
  const type = input.getAttribute("type")?.toLowerCase() ?? "";
  if (!USERNAME_TYPES.has(type) || !isVisibleForm(form) || !isFillable(input)) return null;
  const passwords = [...form.querySelectorAll<HTMLInputElement>('input[type="password"]')]
    .filter((candidate) => candidate.form === form && isFillable(candidate));
  if (passwords.length !== 1) return null;
  const password = passwords[0];
  if (password === undefined
    || !(input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;
  return { username: input, password, form };
}

function snapshotControl(control: HTMLInputElement): ControlSnapshot {
  return {
    value: control.value,
    type: control.type,
    name: control.name,
    autocomplete: control.autocomplete,
  };
}

function snapshotForm(form: HTMLFormElement): FormSnapshot {
  return {
    action: form.action,
    method: form.method,
    target: form.target,
    enctype: form.enctype,
    noValidate: form.noValidate,
  };
}

function createCapabilityId(doc: Document): string | null {
  const crypto = doc.defaultView?.crypto;
  if (crypto === undefined) return null;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function firstFillablePassword(doc: Document): HTMLInputElement | null {
  for (const input of doc.querySelectorAll<HTMLInputElement>("input[type=password]")) {
    if (isVisibleForm(input.form) && isFillable(input)) return input;
  }
  return null;
}

/**
 * The fillable text/email/tel field immediately preceding the password in DOM
 * order - scoped strictly to the password's own visible form.
 * "Immediately preceding" = the last such field that appears before the password.
 */
function usernameFieldFor(
  password: HTMLInputElement,
): TextLikeInput | null {
  const scope = password.form;
  if (!isVisibleForm(scope)) return null;
  const candidates = scope.querySelectorAll<HTMLInputElement>("input");
  let previous: TextLikeInput | null = null;
  for (const input of candidates) {
    if (input === password) break;
    const type = input.getAttribute("type")?.toLowerCase() ?? "";
    if (USERNAME_TYPES.has(type) && isFillable(input)) previous = input;
  }
  return previous;
}

/** Set a controlled input's value so React/Vue-style frameworks observe the change. */
function setFieldValue(input: FillControl, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Perform the fill against `doc`. Returns `{ ok: false, reason: "no-form" }`
 * when there is no fillable password field — the popup surfaces that as "No
 * login form found". A username value is written only when a matching field is
 * found; a lone password still fills.
 */
export function performFill(doc: Document, fields: readonly FillField[]): FillOutcome {
  return executeFill(doc, fields).outcome;
}

interface FillExecution {
  readonly outcome: FillOutcome;
  readonly loginTarget?: {
    readonly password: HTMLInputElement;
    readonly form: HTMLFormElement;
    readonly formState: FormSnapshot;
  };
}

function executeFill(
  doc: Document,
  fields: readonly FillField[],
  submissionUrl?: string,
): FillExecution {
  const generated = fields.find((field) => field.kind === "generated");
  if (generated) {
    const active = doc.activeElement;
    const target = active instanceof HTMLInputElement && isFillable(active)
      ? active
      : firstFillablePassword(doc);
    if (!target) return { outcome: { ok: false, reason: "no-form" } };
    setFieldValue(target, generated.value);
    return { outcome: { ok: true } };
  }

  const cardFields = fields.filter((field) => field.kind.startsWith("card-")
    || field.kind === "cardholder"
    || field.kind === "billing-address");
  if (cardFields.length > 0) return { outcome: performCardFill(doc, cardFields) };

  const password = firstFillablePassword(doc);
  if (!password) return { outcome: { ok: false, reason: "no-form" } };
  const form = password.form;
  if (!isVisibleForm(form)) return { outcome: { ok: false, reason: "no-form" } };
  const formState = snapshotForm(form);
  if (submissionUrl !== undefined && !hasHttpsSubmissionTarget(form, submissionUrl)) {
    return { outcome: { ok: false, reason: "target-changed" } };
  }

  const username = usernameFieldFor(password);
  const targets = fields.flatMap((field): FillControl[] => {
    if (field.kind === "password") return [password];
    if (field.kind === "username" && username !== null) return [username];
    return [];
  });
  if (targets.length === 0
    || targets.some((target) => target.form !== form || !isFillable(target))) {
    return { outcome: { ok: false, reason: "no-form" } };
  }
  for (const field of fields) {
    const target = field.kind === "password"
      ? password
      : field.kind === "username" ? username : null;
    if (target === null) continue;
    if (!isVisibleForm(form)
      || password.form !== form
      || target.form !== form
      || !sameFormState(form, formState)
      || !isFillable(target)) {
      return { outcome: { ok: false, reason: "no-form" } };
    }
    setFieldValue(target, field.value);
  }
  return isVisibleForm(form)
    && password.form === form
    && sameFormState(form, formState)
    && isFillable(password)
    ? { outcome: { ok: true }, loginTarget: { password, form, formState } }
    : { outcome: { ok: false, reason: "no-form" } };
}

/** Final isolated-world binding check immediately before any DOM write. */
export function performBoundFill(
  doc: Document,
  message: FillRequestMessage,
  currentUrl: string,
  currentDocumentId: string,
  inlineCapabilities?: OneShotInlineFillCapabilities,
): FillOutcome {
  if (currentDocumentId !== message.documentId) {
    return { ok: false, reason: "target-changed" };
  }
  try {
    const current = new URL(currentUrl);
    if (current.protocol !== "https:" || current.origin !== message.expectedOrigin) {
      return { ok: false, reason: "target-changed" };
    }
  } catch {
    return { ok: false, reason: "target-changed" };
  }
  if (message.expectedDomain !== null && !matchesTab(currentUrl, message.expectedDomain)) {
    return { ok: false, reason: "target-changed" };
  }
  if (message.capabilityId !== null) {
    if (inlineCapabilities === undefined) return { ok: false, reason: "target-changed" };
    const capability = inlineCapabilities.consume(message.capabilityId);
    if (capability === null) return { ok: false, reason: "target-changed" };
    try {
      return performCapabilityFill(
        capability,
        message.fields,
        message.submit,
        inlineCapabilities,
        currentUrl,
      );
    } finally {
      inlineCapabilities.complete(capability);
    }
  }
  const execution = executeFill(doc, message.fields, message.submit ? currentUrl : undefined);
  if (!execution.outcome.ok || !message.submit) return execution.outcome;
  const target = execution.loginTarget;
  return target !== undefined && submitExactLoginForm(
    target.form,
    target.password,
    currentUrl,
    target.formState,
  )
    ? { ok: true }
    : { ok: false, reason: "target-changed" };
}

function performCapabilityFill(
  capability: InlineFillCapability,
  fields: readonly FillField[],
  submit: boolean,
  capabilities: OneShotInlineFillCapabilities,
  currentUrl: string,
): FillOutcome {
  const usernameFields = fields.filter((field) => field.kind === "username");
  const passwordFields = fields.filter((field) => field.kind === "password");
  if (fields.some((field) => field.kind !== "username" && field.kind !== "password")
    || usernameFields.length > 1
    || passwordFields.length !== 1) {
    return { ok: false, reason: "target-changed" };
  }
  const usernameValue = usernameFields[0]?.value ?? capability.usernameState.value;
  const passwordValue = passwordFields[0]!.value;
  if (submit && !hasHttpsSubmissionTarget(capability.form, currentUrl)) {
    return { ok: false, reason: "target-changed" };
  }
  if (!validateCapabilityTarget(
    capability,
    capability.usernameState.value,
    capability.passwordState.value,
    capabilities,
  )) return { ok: false, reason: "target-changed" };

  if (usernameFields.length === 1) {
    setFieldValue(capability.username, usernameValue);
    if (!validateCapabilityTarget(
      capability,
      usernameValue,
      capability.passwordState.value,
      capabilities,
    )) {
      return { ok: false, reason: "target-changed" };
    }
  }
  setFieldValue(capability.password, passwordValue);
  if (!validateCapabilityTarget(capability, usernameValue, passwordValue, capabilities)) {
    return { ok: false, reason: "target-changed" };
  }
  if (!submit) return { ok: true };
  return submitExactLoginForm(
    capability.form,
    capability.password,
    currentUrl,
    capability.formState,
  )
    ? { ok: true }
    : { ok: false, reason: "target-changed" };
}

function validateCapabilityTarget(
  capability: InlineFillCapability,
  expectedUsername: string,
  expectedPassword: string,
  capabilities: OneShotInlineFillCapabilities,
): boolean {
  const { doc, username, password, form } = capability;
  return capabilities.generationMatches(capability)
    && username.ownerDocument === doc
    && password.ownerDocument === doc
    && form.ownerDocument === doc
    && username.isConnected
    && password.isConnected
    && form.isConnected
    && username.form === form
    && password.form === form
    && sameControlState(username, capability.usernameState, expectedUsername)
    && sameControlState(password, capability.passwordState, expectedPassword)
    && sameFormState(form, capability.formState)
    && isVisibleForm(form)
    && isFillable(username)
    && isFillable(password);
}

function sameControlState(
  control: HTMLInputElement,
  snapshot: ControlSnapshot,
  expectedValue: string,
): boolean {
  return control.value === expectedValue
    && control.type === snapshot.type
    && control.name === snapshot.name
    && control.autocomplete === snapshot.autocomplete;
}

function sameFormState(form: HTMLFormElement, snapshot: FormSnapshot): boolean {
  return form.action === snapshot.action
    && form.method === snapshot.method
    && form.target === snapshot.target
    && form.enctype === snapshot.enctype
    && form.noValidate === snapshot.noValidate;
}

function submitExactLoginForm(
  form: HTMLFormElement,
  password: HTMLInputElement,
  currentUrl: string,
  expectedFormState: FormSnapshot,
): boolean {
  if (!isVisibleForm(form)
    || !password.isConnected
    || password.form !== form
    || !sameFormState(form, expectedFormState)
    || !isFillable(password)
    || !hasHttpsSubmissionTarget(form, currentUrl)) return false;
  try {
    // No submitter is selected: page-owned button overrides (`formaction`,
    // `formmethod`, `formenctype`, `formtarget`) are therefore not activated.
    form.requestSubmit();
    return true;
  } catch {
    return false;
  }
}

function hasHttpsSubmissionTarget(form: HTMLFormElement, currentUrl: string): boolean {
  try {
    const target = new URL(form.action);
    const current = new URL(currentUrl);
    return target.protocol === "https:" && target.origin === current.origin;
  } catch {
    return false;
  }
}

function performCardFill(doc: Document, fields: readonly FillField[]): FillOutcome {
  const values = new Map(fields.map((field) => [field.kind, field.value]));
  const filledKinds = new Set<FillField["kind"]>();
  const candidates = [...doc.querySelectorAll<FillControl>("input[autocomplete], textarea[autocomplete]")]
    .filter((input) => isVisibleForm(input.form) && isFillable(input));
  const targetForm = candidates[0]?.form ?? null;
  if (!isVisibleForm(targetForm)) return { ok: false, reason: "no-form" };
  for (const input of candidates) {
    if (input.form !== targetForm || !isVisibleForm(targetForm) || !isFillable(input)) continue;
    const tokens = (input.getAttribute("autocomplete") ?? "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const fieldName = tokens.at(-1) ?? "";
    let kind = CARD_AUTOCOMPLETE_KIND[fieldName];
    if ((fieldName === "street-address" || fieldName === "address-line1")
      && tokens.includes("billing")) {
      kind = "billing-address";
    }
    // Deliberately ignore cc-csc and every label/name heuristic. A neutral
    // custom field must never become payment authentication data by accident.
    if (kind === undefined || filledKinds.has(kind)) continue;
    const value = values.get(kind);
    if (value === undefined || value.length === 0) continue;
    setFieldValue(input, value);
    filledKinds.add(kind);
  }
  return filledKinds.size > 0 ? { ok: true } : { ok: false, reason: "no-form" };
}
