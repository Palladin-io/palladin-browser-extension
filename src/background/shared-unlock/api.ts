import type { SharedUnlockSessionState } from './api-types'
import type { FetchLike } from "../session/auth-client";
import type { SessionTokens } from "../session/types";
import type {
  SharedUnlockActivationInput, SharedUnlockActivityInput, SharedUnlockAuthorization,
  SharedUnlockCommit, SharedUnlockLink, SharedUnlockManualInput, SharedUnlockOperation,
  SharedUnlockOperationInput, SharedUnlockPreference,
} from "./api-types";

export type SharedUnlockApiErrorCode =
  | "unauthorized" | "forbidden" | "not-found" | "conflict"
  | "rate-limited" | "unavailable" | "network" | "cancelled";

export class SharedUnlockApiError extends Error {
  constructor(readonly code: SharedUnlockApiErrorCode) {
    super("Shared unlock request failed");
    this.name = "SharedUnlockApiError";
  }
}

const accountPath = "/api/account/shared-unlock";
const linkPath = (linkId: string) => `${accountPath}/links/${encodeURIComponent(linkId)}`;
const proofPath = (operationId: string) => `/api/auth/shared-unlock/operations/${encodeURIComponent(operationId)}`;

export class SharedUnlockApi {
  constructor(
    private readonly doFetch: FetchLike,
    private readonly currentApiUrl: () => string,
  ) {}

  readPreference(session: SessionTokens, signal?: AbortSignal): Promise<SharedUnlockPreference> {
    return this.request(session.apiUrl, accountPath, "GET", undefined, session, signal);
  }

  setPreference(session: SessionTokens, enabled: boolean, revision: number, signal?: AbortSignal): Promise<SharedUnlockPreference> {
    return this.request(session.apiUrl, accountPath, "PUT",
      { sharedUnlockEnabled: enabled, expectedRevision: revision }, session, signal);
  }

  createLink(session: SessionTokens, linkId: string, preferenceRevision: number, signal?: AbortSignal): Promise<SharedUnlockLink> {
    return this.request(session.apiUrl, `${accountPath}/links`, "POST",
      { linkId, expectedPreferenceRevision: preferenceRevision }, session, signal);
  }

  readSessionState(session: SessionTokens, linkId: string, signal?: AbortSignal): Promise<SharedUnlockSessionState> {
    return this.request(session.apiUrl, `${accountPath}/session-state`, 'POST',
      { linkId, refreshToken: session.refreshToken }, session, signal);
  }

  readLink(session: SessionTokens, linkId: string, signal?: AbortSignal): Promise<SharedUnlockLink> {
    return this.request(session.apiUrl, linkPath(linkId), "GET", undefined, session, signal);
  }

  activate(session: SessionTokens, linkId: string, input: SharedUnlockActivationInput, signal?: AbortSignal): Promise<SharedUnlockLink> {
    return this.request(session.apiUrl, `${linkPath(linkId)}/activate`, "POST",
      { ...input, refreshToken: session.refreshToken }, session, signal);
  }

  lock(session: SessionTokens, linkId: string, revision: number, preferenceRevision: number, signal?: AbortSignal): Promise<SharedUnlockLink> {
    return this.closeLink("lock", session, linkId, revision, preferenceRevision, signal);
  }

  logout(session: SessionTokens, linkId: string, revision: number, preferenceRevision: number, signal?: AbortSignal): Promise<SharedUnlockLink> {
    return this.closeLink("logout", session, linkId, revision, preferenceRevision, signal);
  }

  disconnect(session: SessionTokens, linkId: string, revision: number, signal?: AbortSignal): Promise<SharedUnlockLink> {
    return this.request(session.apiUrl, `${linkPath(linkId)}/disconnect`, "POST", { expectedRevision: revision }, session, signal);
  }

  reconnect(session: SessionTokens, linkId: string, revision: number, signal?: AbortSignal): Promise<SharedUnlockLink> {
    return this.request(session.apiUrl, `${linkPath(linkId)}/reconnect`, "POST", { expectedRevision: revision }, session, signal);
  }

  authorize(session: SessionTokens, input: SharedUnlockManualInput, signal?: AbortSignal): Promise<SharedUnlockAuthorization> {
    return this.request(session.apiUrl, `${accountPath}/authorizations`, "POST",
      { ...input, refreshToken: session.refreshToken }, session, signal);
  }

  recordActivity(session: SessionTokens, input: SharedUnlockActivityInput, signal?: AbortSignal): Promise<SharedUnlockAuthorization> {
    return this.request(session.apiUrl, `${accountPath}/authorizations/activity`, "POST",
      { ...input, refreshToken: session.refreshToken }, session, signal);
  }

  createOperation(session: SessionTokens, input: SharedUnlockOperationInput, signal?: AbortSignal): Promise<SharedUnlockOperation> {
    return this.request(session.apiUrl, `${accountPath}/operations`, "POST",
      { ...input, refreshToken: session.refreshToken }, session, signal);
  }

  consume(expectedApiUrl: string, operationId: string, signature: string, signal?: AbortSignal): Promise<SharedUnlockOperation> {
    return this.request(expectedApiUrl, `${proofPath(operationId)}/consume`, "POST", { signature }, undefined, signal);
  }

  commit(expectedApiUrl: string, operationId: string, signature: string, signal?: AbortSignal,
    onIssued?: (commit: SharedUnlockCommit) => void): Promise<SharedUnlockCommit> {
    return this.request(expectedApiUrl, `${proofPath(operationId)}/commit`, "POST", { signature }, undefined, signal, onIssued);
  }

  /** Cleanup only: revoke the newly issued own lineage on its original Identity.
   * Authenticate with that issued own session, never the peer/current session.
   * No current-session mutation, peer/group logout or retry. */
  async revokeIssuedSession(apiUrl: string, issuedSession: Pick<SharedUnlockCommit['session'], 'accessToken' | 'refreshToken'>): Promise<void> {
    const { accessToken, refreshToken } = issuedSession;
    const abort = new AbortController();
    let finishTimeout!: () => void;
    const elapsed = new Promise<void>(resolve => { finishTimeout = resolve; });
    const timeout = setTimeout(() => { abort.abort(); finishTimeout(); }, 2000);
    try {
      await Promise.race([this.doFetch(`${apiUrl.replace(/\/$/, "")}/api/auth/logout`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ refreshToken }), signal: abort.signal,
        redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
      }), elapsed]);
    } catch { /* Best-effort cleanup; local key disposal is unconditional. */ }
    finally { clearTimeout(timeout); }
  }

  private closeLink(action: "lock" | "logout", session: SessionTokens, linkId: string, revision: number, preferenceRevision: number, signal?: AbortSignal): Promise<SharedUnlockLink> {
    return this.request(session.apiUrl, `${linkPath(linkId)}/${action}`, "POST",
      { expectedRevision: revision, expectedPreferenceRevision: preferenceRevision }, session, signal);
  }

  private assertCurrent(apiUrl: string, signal?: AbortSignal): void {
    if (signal?.aborted || this.currentApiUrl() !== apiUrl) throw new SharedUnlockApiError("cancelled");
  }

  private async request<T>(apiUrl: string, path: string, method: "GET" | "POST" | "PUT", body?: object,
    session?: SessionTokens, signal?: AbortSignal, onIssued?: (result: T) => void): Promise<T> {
    this.assertCurrent(apiUrl, signal);
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (session) headers["authorization"] = `Bearer ${session.accessToken}`;
    try {
      const response = await this.doFetch(`${apiUrl}${path}`, {
        method, headers, redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
      // An available late commit body must reach own-lineage cleanup before
      // cancellation rejects it. Other requests still fence before decoding.
      if (!onIssued || !response.ok) this.assertCurrent(apiUrl, signal);
      if (!response.ok) {
        const code: SharedUnlockApiErrorCode = ({
          401: "unauthorized", 403: "forbidden", 404: "not-found", 409: "conflict",
          429: "rate-limited", 503: "unavailable",
        } as const)[response.status] ?? "network";
        throw new SharedUnlockApiError(code);
      }
      const result = await response.json() as T;
      onIssued?.(result);
      this.assertCurrent(apiUrl, signal);
      return result;
    } catch (error) {
      this.assertCurrent(apiUrl, signal);
      if (error instanceof SharedUnlockApiError) throw error;
      throw new SharedUnlockApiError("network");
    }
  }
}
