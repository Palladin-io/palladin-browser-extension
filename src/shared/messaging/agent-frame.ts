import { registrableDomain, isSecurePage } from '../security/domain';
export const AGENT_FRAME_LIST_CHANNEL = 'palladin.agent-live/visible-frames';
export interface AgentFrameListRequest { readonly channel: typeof AGENT_FRAME_LIST_CHANNEL }
export function isAgentFrameListRequest(raw: unknown): raw is AgentFrameListRequest {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    && Object.keys(raw).length === 1 && 'channel' in raw && raw.channel === AGENT_FRAME_LIST_CHANNEL;
}
/** Framed login is limited to a direct, HTTPS, same-site child. Entry host
 * authorization remains independent and is checked by native and isolated code. */
export function sameSiteLoginFrame(topUrl: string, childUrl: string): boolean {
  if (!isSecurePage(topUrl) || !isSecurePage(childUrl)) return false;
  const site = registrableDomain(topUrl);
  return site !== null && site === registrableDomain(childUrl);
}
