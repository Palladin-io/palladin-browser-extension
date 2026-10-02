import { AGENT_FRAME_LIST_CHANNEL, sameSiteLoginFrame } from '@shared/messaging/agent-frame';
import { TAB_URL_REQUEST_CHANNEL, isTabUrlResponse, parseAgentInjectForm, isAgentInjectStepOutcome, isAgentInjectTransitionOutcome, AGENT_INJECT_STEP_CHANNEL, AGENT_INJECT_TRANSITION_CHANNEL } from '@shared/messaging';
import { AGENT_LIVE_INSPECT_CHANNEL, AGENT_LIVE_PROBE_CHANNEL, parseLiveLoginProbe } from '@shared/messaging/agent-live';
import { DEFERRED_CANCEL, parseSubmitReady } from '@shared/messaging/agent-deferred';
import type { AgentFillDeps, AgentTabState, PreparedFrame } from './native-provider';

type Frame = chrome.webNavigation.GetAllFrameResultDetails;
export interface FrameTransport {
  frames(tabId: number): Promise<Frame[] | null>;
  send(tabId: number, documentId: string, message: unknown): Promise<unknown>;
}
/** The browser owns frame/document IDs. Page-provided URLs are only visibility
 * hints, intersected with browser metadata; they never authorize a destination. */
export async function prepareLoginFrame(top: AgentTabState, transport: FrameTransport, isActive: () => boolean): Promise<PreparedFrame | null> {
  if (!top.page) return null;
  const frames = await transport.frames(top.id);
  const outer = frames?.find(frame => frame.frameId === 0 && frame.parentFrameId === -1 && frame.documentLifecycle === 'active');
  if (!frames || frames.length !== 2 || !outer || outer.url !== top.page.url) return null;
  const visible = await transport.send(top.id, outer.documentId, { channel: AGENT_FRAME_LIST_CHANNEL });
  if (!Array.isArray(visible) || visible.length > 16 || !visible.every(url => typeof url === 'string')) return null;
  const candidates: PreparedFrame[] = [];
  for (const frame of frames) {
    if (frame.parentFrameId !== 0 || frame.parentDocumentId !== outer.documentId || frame.documentLifecycle !== 'active' || !sameSiteLoginFrame(outer.url, frame.url)
      || visible.filter(url => url === frame.url).length !== 1) continue;
    const deps = frameDeps(top, outer, frame, transport, isActive);
    const page = await deps.getPageById(top.id);
    if (!page?.page) continue;
    const form = await deps.inspectLiveLogin?.(top.id, page.page.documentId, page.page.url);
    if (form) candidates.push({ page, form, deps });
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

function frameDeps(top: AgentTabState, outer: Frame, initial: Frame, transport: FrameTransport, isActive: () => boolean): AgentFillDeps {
  // Navigation after a committed step may renew this child's document, but may
  // never select another frame, URL, outer document or iframe element/src.
  // First support is deliberately limited to a single direct frame; matching
  // a visible src to one of several browser frames is not an identity proof.

  let cleanup: { pendingId: string; documentId: string } | null = null;
  async function current(): Promise<{ frame: Frame; page: NonNullable<AgentTabState['page']> } | null> {
    if (!isActive()) return null;
    const frames = await transport.frames(top.id);
    const parent = frames?.find(frame => frame.frameId === 0);
    const frame = frames?.find(frame => frame.frameId === initial.frameId);
    if (frames?.length !== 2 || !parent || parent.documentLifecycle !== 'active' || parent.documentId !== outer.documentId || parent.url !== outer.url
      || !frame || frame.parentFrameId !== 0 || frame.parentDocumentId !== outer.documentId || frame.documentLifecycle !== 'active' || frame.url !== initial.url) return null;
    const visible = await transport.send(top.id, outer.documentId, { channel: AGENT_FRAME_LIST_CHANNEL });
    if (!Array.isArray(visible) || visible.filter(url => url === initial.url).length !== 1) return null;
    const page = await transport.send(top.id, frame.documentId, { channel: TAB_URL_REQUEST_CHANNEL });
    if (!isTabUrlResponse(page) || page.url !== frame.url) return null;
    return { frame, page };
  }
  async function send(message: unknown, isolatedDocument?: string, pendingId?: string): Promise<unknown> {
    const target = await current();
    if (!isActive() || !target || (isolatedDocument !== undefined && target.page.documentId !== isolatedDocument)) return null;
    if (pendingId) cleanup = { pendingId, documentId: target.frame.documentId };
    return transport.send(top.id, target.frame.documentId, message);
  }
  const getPageById = async (tabId: number): Promise<AgentTabState | null> => {
    if (tabId !== top.id) return null;
    const target = await current();
    return target ? { id: top.id, page: target.page } : null;
  };
  return {
    getPageById, getActivePage: () => getPageById(top.id),
    async inspectLiveLogin(tabId, documentId, targetUrl) {
      if (tabId !== top.id) return null;
      return parseAgentInjectForm(await send({ channel: AGENT_LIVE_INSPECT_CHANNEL, documentId, targetUrl }, documentId));
    },
    async probeLiveLogin(tabId, documentId, targetUrl) {
      if (tabId !== top.id) return null;
      return parseLiveLoginProbe(await send({ channel: AGENT_LIVE_PROBE_CHANNEL, documentId, targetUrl }, documentId));
    },
    async fillDeferred(tabId, message) {
      if (tabId !== top.id) return null;
      const response = await send(message, message.documentId, message.pendingId);
      if (typeof response === 'object' && response !== null && 'ok' in response && response.ok === true
        && 'submitReady' in response && Object.keys(response).length === 2) {
        const ready = parseSubmitReady(response.submitReady);
        return ready ? { ok: true, submitReady: ready } : null;
      }
      return isAgentInjectStepOutcome(response) && !response.ok ? response : null;
    },
    async commitDeferred(tabId, message) {
      if (tabId !== top.id) return null;
      const response = await send(message, message.submitReady.documentId);
      return isAgentInjectStepOutcome(response) ? response : null;
    },
    async cancelDeferred(tabId, pendingId) {
      if (tabId !== top.id || cleanup?.pendingId !== pendingId) return;
      const target = cleanup; cleanup = null;
      // Cleanup remains addressed to the original document even if now hidden.
      await transport.send(top.id, target.documentId, { channel: DEFERRED_CANCEL, pendingId });
    },
    async sendStep(tabId, expectedDomain, documentId, step, values, requireExistingUsername) {
      if (tabId !== top.id) return null;
      const response = await send({ channel: AGENT_INJECT_STEP_CHANNEL, expectedDomain, documentId, step, values,
        ...(requireExistingUsername ? { requireExistingUsername: true } : {}) }, documentId);
      return isAgentInjectStepOutcome(response) ? response : null;
    },
    async probeTransition(tabId, expectedDomain, selector) {
      if (tabId !== top.id) return null;
      const response = await send({ channel: AGENT_INJECT_TRANSITION_CHANNEL, expectedDomain, selector });
      return isAgentInjectTransitionOutcome(response) ? response : null;
    },
  };
}
