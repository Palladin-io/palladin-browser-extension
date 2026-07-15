/**
 * The popup's typed door to the service worker.
 *
 * Every method is one {@link SessionCommand} sent over `chrome.runtime`
 * messaging (the popup shares the extension origin, isolated from any page — so
 * passwords and codes travel here, never through a page-facing surface). A
 * successful reply is unwrapped to its payload; an `ok:false` reply becomes a
 * {@link PopupSessionError} the screens localise. `send` is injectable so the
 * whole surface is testable without a live `chrome`.
 */

import type { SessionCapabilities } from "../../background/session/capabilities";
import type {
  SessionCommand,
  SessionCommandResult,
} from "../../background/session/commands";
import type { LoginResult, SessionStatus } from "../../background/session/types";
import { PopupSessionError } from "./errors";

export interface SessionClient {
  getStatus(): Promise<SessionStatus>;
  getCapabilities(): Promise<SessionCapabilities>;
  login(email: string, password: string): Promise<LoginResult>;
  completeTotp(challengeToken: string, code: string, password: string): Promise<SessionStatus>;
  unlock(password: string): Promise<SessionStatus>;
  lock(): Promise<void>;
  logout(): Promise<void>;
}

export type SendCommand = (command: SessionCommand) => Promise<SessionCommandResult | undefined>;

/** Default transport: hand the command to the worker and await its response. */
const chromeSend: SendCommand = (command) =>
  chrome.runtime.sendMessage(command) as Promise<SessionCommandResult | undefined>;

/**
 * Send a command and either return the successful result or throw a typed
 * error. A missing/garbled reply (no listener, worker asleep) is treated as a
 * network failure rather than a silent success.
 */
async function dispatch(send: SendCommand, command: SessionCommand): Promise<SessionCommandResult> {
  const result = await send(command);
  if (!result || typeof result !== "object" || !("ok" in result)) {
    throw new PopupSessionError("network");
  }
  if (!result.ok) throw new PopupSessionError(result.code);
  return result;
}

export function createSessionClient(send: SendCommand = chromeSend): SessionClient {
  return {
    async getStatus() {
      const result = await dispatch(send, { type: "session/status" });
      if (!("status" in result)) throw new PopupSessionError("network");
      return result.status;
    },
    async getCapabilities() {
      const result = await dispatch(send, { type: "session/capabilities" });
      if (!("capabilities" in result)) throw new PopupSessionError("network");
      return result.capabilities;
    },
    async login(email, password) {
      const result = await dispatch(send, { type: "session/login", email, password });
      if (!("login" in result)) throw new PopupSessionError("network");
      return result.login;
    },
    async completeTotp(challengeToken, code, password) {
      const result = await dispatch(send, {
        type: "session/completeTotp",
        challengeToken,
        code,
        password,
      });
      if (!("status" in result)) throw new PopupSessionError("network");
      return result.status;
    },
    async unlock(password) {
      const result = await dispatch(send, { type: "session/unlock", password });
      if (!("status" in result)) throw new PopupSessionError("network");
      return result.status;
    },
    async lock() {
      await dispatch(send, { type: "session/lock" });
    },
    async logout() {
      await dispatch(send, { type: "session/logout" });
    },
  };
}
