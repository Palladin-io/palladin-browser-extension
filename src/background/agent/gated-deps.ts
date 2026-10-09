import type { AgentFillDeps } from "./native-provider";

/** Gate every awaited lookup and page operation against connection lifecycle. */
export function gateAgentFillDeps(
  deps: AgentFillDeps,
  isActive: () => boolean,
): AgentFillDeps {
  return {
    async probeTarget(tabId, targetUrl) {
      if (!isActive() || !deps.probeTarget) return 'unavailable';
      const outcome = await deps.probeTarget(tabId, targetUrl);
      return isActive() ? outcome : 'unavailable';
    },
    async prepareFrame(top, parentActive) {
      if (!isActive() || !deps.prepareFrame) return null;
      const prepared = await deps.prepareFrame(top, () => isActive() && parentActive());
      return isActive() && prepared ? { ...prepared, deps: gateAgentFillDeps(prepared.deps, isActive) } : null;
    },
    currentAutomaticFillSession: () => isActive() ? deps.currentAutomaticFillSession?.() ?? null : null,
    async fillDeferred(tabId, message) {
      if (!isActive() || !deps.fillDeferred) return null;
      const response = await deps.fillDeferred(tabId, message);
      if (!isActive()) { void deps.cancelDeferred?.(tabId, message.pendingId).catch(() => undefined); return null; }
      return response;
    },
    async commitDeferred(tabId, message) {
      if (!isActive() || !deps.commitDeferred) return null;
      const response = await deps.commitDeferred(tabId, message);
      return isActive() ? response : null;
    },
    async cancelDeferred(tabId, pendingId) { await deps.cancelDeferred?.(tabId, pendingId); },
    async probeLiveLogin(tabId, documentId, targetUrl) {
      if (!isActive() || !deps.probeLiveLogin) return null;
      const result = await deps.probeLiveLogin(tabId, documentId, targetUrl);
      return isActive() ? result : null;
    },
    async inspectLiveLogin(tabId, documentId, targetUrl) {
      if (!isActive() || !deps.inspectLiveLogin) return null;
      const result = await deps.inspectLiveLogin(tabId, documentId, targetUrl);
      return isActive() ? result : null;
    },

    async getActivePage() {
      if (!isActive()) return null;
      const page = await deps.getActivePage();
      return isActive() ? page : null;
    },
    async getPageById(tabId) {
      if (!isActive()) return null;
      const page = await deps.getPageById(tabId);
      return isActive() ? page : null;
    },
    async sendStep(tabId, expectedDomain, documentId, step, values, requireExistingUsername) {
      if (!isActive()) return null;
      const outcome = await deps.sendStep(tabId, expectedDomain, documentId, step, values, ...(requireExistingUsername ? [true] : []));
      return isActive() ? outcome : null;
    },
    async probeTransition(tabId, expectedDomain, selector) {
      if (!isActive()) return null;
      const outcome = await deps.probeTransition(tabId, expectedDomain, selector);
      return isActive() ? outcome : null;
    },
    async wait(milliseconds) {
      if (!isActive()) return;
      if (deps.wait) {
        await deps.wait(milliseconds);
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
      }
    },
  };
}

