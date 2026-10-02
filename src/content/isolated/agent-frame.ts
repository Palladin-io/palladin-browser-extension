import { sameSiteLoginFrame } from '@shared/messaging/agent-frame';
import { isVisibleScopeHint } from './login-controls';
import type { AgentInjectDomAccess } from './agent-inject';
export function visibleLoginFrameUrls(doc: Document, dom: AgentInjectDomAccess): string[] {
  if (doc.defaultView?.top !== doc.defaultView) return [];
  const frames = [...doc.querySelectorAll('iframe')];
  if (frames.length !== 1) return [];
  return frames.filter(frame => !frame.hasAttribute('sandbox')
    && isVisibleScopeHint(frame) && dom.isVisible(frame) && sameSiteLoginFrame(doc.URL, frame.src)).map(frame => frame.src);
}
export function agentLoginFrameAllowed(win: Window): boolean {
  if (win.top === win) return true;
  // ancestorOrigins comes from the browser, not from a page message or referrer.
  return win.parent === win.top && win.location.ancestorOrigins?.length === 1
    && sameSiteLoginFrame(win.location.ancestorOrigins[0]!, win.location.href);
}
