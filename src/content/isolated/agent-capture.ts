import { CAPTURE_FIELD_BYTES, CAPTURE_TOTAL_BYTES, isAgentCaptureMessage, isAgentCaptureOutcome, wipeCaptureOutcome, type AgentCaptureMessage, type AgentCaptureOutcome, type AgentCaptureValue } from '@shared/messaging/agent-capture';
import { createAgentInjectDomAccess, type AgentInjectDomAccess } from './agent-inject';

/** Read only declared top-document elements in the isolated world. Never evaluates page code. */
export function captureAgentFields(doc: Document, message: AgentCaptureMessage, documentId: string,
  currentUrl: () => string, dom: AgentInjectDomAccess = createAgentInjectDomAccess(doc)): AgentCaptureOutcome {
  const values: AgentCaptureValue[] = [];
  let success = false;
  let totalBytes = 0;
  try {
    if (!isAgentCaptureMessage(message) || message.documentId !== documentId || currentUrl() !== message.targetUrl
      || !doc.defaultView || doc.defaultView.top !== doc.defaultView) return { outcome: 'rejected' };
    const win = doc.defaultView;
    const elements = new Set<Element>();
    for (const field of message.fields) {
      const matches = doc.querySelectorAll(field.selector);
      if (matches.length !== 1) return { outcome: 'rejected' };
      const element = matches[0];
      if (!(element instanceof win.HTMLElement) || !element.isConnected || element.ownerDocument !== doc || !dom.isVisible(element) || elements.has(element)) return { outcome: 'rejected' };
      elements.add(element);
      const budget = Math.min(CAPTURE_FIELD_BYTES, CAPTURE_TOTAL_BYTES - totalBytes);
      let value: string;
      if (field.read === 'value') {
        if (element instanceof win.HTMLInputElement && ['text', 'password', 'email', 'tel', 'url', 'search', 'number'].includes(element.type)) value = element.value;
        else if (element instanceof win.HTMLTextAreaElement) value = element.value;
        else return { outcome: 'rejected' };
      } else {
        if (!['DIV', 'SPAN', 'P', 'PRE', 'CODE', 'OUTPUT', 'TD', 'TH', 'DD', 'DT', 'LI'].includes(element.tagName)) return { outcome: 'rejected' };
        const text = boundedText(element, budget);
        if (text === null) return { outcome: 'rejected' };
        value = text;
      }
      const bytes = byteLengthWithin(value, budget);
      if (bytes === null) return { outcome: 'rejected' };
      totalBytes += bytes;
      values.push({ entryFieldId: field.entryFieldId, value });
    }
    const outcome: AgentCaptureOutcome = { outcome: 'captured', values };
    if (currentUrl() !== message.targetUrl || [...elements].some(el => !el.isConnected || !dom.isVisible(el as HTMLElement)) || !isAgentCaptureOutcome(outcome)) return { outcome: 'rejected' };
    success = true;
    return outcome;
  } catch { return { outcome: 'rejected' }; }
  finally { if (!success) wipeCaptureOutcome({ outcome: 'captured', values }); }
}

function byteLengthWithin(value: string, budget: number): number | null {
  // A UTF-16 code unit needs at least one UTF-8 byte, so avoid encoding oversized values.
  if (value.length > budget) return null;
  const bytes = new TextEncoder().encode(value);
  const length = bytes.length;
  bytes.fill(0);
  return length <= budget ? length : null;
}

function boundedText(element: HTMLElement, budget: number): string | null {
  // Never call element.textContent: it concatenates the entire subtree before
  // its size can be checked. Text.length lets us reject huge individual nodes first.
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* SHOW_TEXT */);
  const parts: string[] = [];
  let remaining = budget;
  try {
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      if (text.length > remaining) return null;
      if (text.length === 0) continue;
      const value = text.data;
      const bytes = byteLengthWithin(value, remaining);
      if (bytes === null) return null;
      remaining -= bytes;
      parts.push(value);
    }
    return parts.join('');
  } finally { parts.fill(''); }
}
