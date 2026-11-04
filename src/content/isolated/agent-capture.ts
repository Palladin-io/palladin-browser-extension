import { isAgentCaptureMessage, isAgentCaptureOutcome, wipeCaptureOutcome, type AgentCaptureMessage, type AgentCaptureOutcome, type AgentCaptureValue } from '@shared/messaging/agent-capture';
import { createAgentInjectDomAccess, type AgentInjectDomAccess } from './agent-inject';

/** Read only declared top-document elements in the isolated world. Never evaluates page code. */
export function captureAgentFields(doc: Document, message: AgentCaptureMessage, documentId: string,
  currentUrl: () => string, dom: AgentInjectDomAccess = createAgentInjectDomAccess(doc)): AgentCaptureOutcome {
  const values: AgentCaptureValue[] = [];
  let success = false;
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
      let value: string;
      if (field.read === 'value') {
        if (element instanceof win.HTMLInputElement && ['text', 'password', 'email', 'tel', 'url', 'search', 'number'].includes(element.type)) value = element.value;
        else if (element instanceof win.HTMLTextAreaElement) value = element.value;
        else return { outcome: 'rejected' };
      } else {
        if (!['DIV', 'SPAN', 'P', 'PRE', 'CODE', 'OUTPUT', 'TD', 'TH', 'DD', 'DT', 'LI'].includes(element.tagName)) return { outcome: 'rejected' };
        value = element.textContent ?? '';
      }
      values.push({ entryFieldId: field.entryFieldId, value });
    }
    const outcome: AgentCaptureOutcome = { outcome: 'captured', values };
    if (currentUrl() !== message.targetUrl || [...elements].some(el => !el.isConnected || !dom.isVisible(el as HTMLElement)) || !isAgentCaptureOutcome(outcome)) return { outcome: 'rejected' };
    success = true;
    return outcome;
  } catch { return { outcome: 'rejected' }; }
  finally { if (!success) wipeCaptureOutcome({ outcome: 'captured', values }); }
}
