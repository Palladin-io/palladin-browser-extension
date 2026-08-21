/**
 * Typed command channel between the popup and the service worker.
 *
 * This is a SEPARATE transport from the content bridge: the popup and the worker
 * share the extension origin (isolated from any page), so passwords and codes for
 * login/unlock travel here over `chrome.runtime` messaging — never through a
 * page-facing surface. {@link dispatchSessionCommand} is a pure async function
 * over a {@link SessionManager}, so the whole command surface is testable without
 * a live `chrome`; the worker just adapts `onMessage` onto it.
 *
 * Responses are a discriminated `ok` union so the popup localises failures from
 * the typed {@link SessionErrorCode} instead of matching on message strings.
 */

import type { AutoLockPolicy } from "./auto-lock";
import { isAutoLockPolicy } from "./auto-lock";
import { getSessionCapabilities, type SessionCapabilities } from "./capabilities";
import type { SessionManager } from "./session-manager";
import {
  SessionError,
  type LoginResult,
  type SessionErrorCode,
  type SessionStatus,
} from "./types";

export type SessionCommand =
  | { readonly type: "session/status" }
  | { readonly type: "session/capabilities" }
  | { readonly type: "session/login"; readonly email: string; readonly password: string }
  | {
      readonly type: "session/completeTotp";
      readonly challengeToken: string;
      readonly code: string;
    }
  | { readonly type: "session/cancelTotp" }
  | { readonly type: "session/unlock"; readonly password: string }
  | { readonly type: "session/lock" }
  | { readonly type: "session/logout" }
  | { readonly type: "session/getAutoLock" }
  | { readonly type: "session/setAutoLock"; readonly policy: AutoLockPolicy };

export type SessionCommandType = SessionCommand["type"];

export type SessionCommandResult =
  | { readonly ok: true; readonly status: SessionStatus }
  | { readonly ok: true; readonly capabilities: SessionCapabilities }
  | { readonly ok: true; readonly login: LoginResult }
  | { readonly ok: true; readonly policy: AutoLockPolicy }
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SessionErrorCode; readonly message: string };

function isSessionCommand(value: unknown): value is SessionCommand {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("session/");
}

function failure(error: unknown): SessionCommandResult {
  if (error instanceof SessionError) {
    return { ok: false, code: error.code, message: error.message };
  }
  // Never surface a raw error (could carry a value); collapse to a network code.
  return { ok: false, code: "network", message: "Session command failed" };
}

export async function dispatchSessionCommand(
  manager: SessionManager,
  command: SessionCommand,
): Promise<SessionCommandResult> {
  try {
    switch (command.type) {
      case "session/status":
        return { ok: true, status: await manager.getStatus() };
      case "session/capabilities":
        return { ok: true, capabilities: getSessionCapabilities() };
      case "session/login":
        return { ok: true, login: await manager.login(command.email, command.password) };
      case "session/completeTotp":
        await manager.completeTotp(command.challengeToken, command.code);
        return { ok: true, status: await manager.getStatus() };
      case "session/cancelTotp":
        manager.cancelTotp();
        return { ok: true };
      case "session/unlock":
        await manager.unlockWithPassword(command.password);
        return { ok: true, status: "unlocked" };
      case "session/lock":
        await manager.lock();
        return { ok: true, status: "locked" };
      case "session/logout":
        await manager.logout();
        return { ok: true, status: "signed-out" };
      case "session/getAutoLock":
        return { ok: true, policy: await manager.getAutoLockPolicy() };
      case "session/setAutoLock": {
        if (!isAutoLockPolicy(command.policy)) {
          return { ok: false, code: "invalid-credentials", message: "Unknown auto-lock policy" };
        }
        await manager.setAutoLockPolicy(command.policy);
        return { ok: true, policy: command.policy };
      }
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  } catch (error) {
    return failure(error);
  }
}

/**
 * Adapt a raw `chrome.runtime.onMessage` payload onto the manager. Returns a
 * response for recognised session commands, or `null` for anything else (so
 * other listeners can handle it). Never throws — failures come back as `ok:false`.
 */
export async function handleRuntimeMessage(
  manager: SessionManager,
  raw: unknown,
): Promise<SessionCommandResult | null> {
  if (!isSessionCommand(raw)) return null;
  return dispatchSessionCommand(manager, raw);
}
