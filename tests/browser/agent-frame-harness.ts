import { handleNativeAgentMessage, type AgentFillDeps, type AgentProviderSession } from '../../src/background/agent/native-provider';
import { prepareLoginFrame } from '../../src/background/agent/frame-routing';
import { isTabUrlResponse, TAB_URL_REQUEST_CHANNEL, parseAgentInjectForm } from '../../src/shared/messaging';
import { AGENT_LIVE_INSPECT_CHANNEL } from '../../src/shared/messaging/agent-live';
const transport = {
  frames: (tabId: number) => chrome.webNavigation.getAllFrames({ tabId }),
  send: (tabId: number, documentId: string, message: unknown) => chrome.tabs.sendMessage(tabId, message, { documentId }),
};
let session: AgentProviderSession = { prepared: null };
const deps: AgentFillDeps = {
  getActivePage: async () => null,
  getPageById: async id => {
    const page = await chrome.tabs.sendMessage(id, { channel: TAB_URL_REQUEST_CHANNEL }, { frameId: 0 });
    return { id, page: isTabUrlResponse(page) ? page : null };
  },
  inspectLiveLogin: async (id, documentId, targetUrl) => parseAgentInjectForm(await chrome.tabs.sendMessage(id,
    { channel: AGENT_LIVE_INSPECT_CHANNEL, documentId, targetUrl }, { frameId: 0 })),
  prepareFrame: (top, isActive) => prepareLoginFrame(top, transport, isActive),
  sendStep: async () => null, probeTransition: async () => null,
};
export async function send(raw: unknown) {
  return handleNativeAgentMessage(deps, { consume: async () => true }, session, raw);
}
export function reset() { session = { prepared: null }; }
