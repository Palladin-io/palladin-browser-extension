/**
 * Session state stub. Today it holds only a lock status flag — no keys, no
 * secrets. When the crypto package lands (CVT-365) the unlocked keys will live
 * in `chrome.storage.session` (memory-backed, cleared when the browser closes),
 * and NEVER in localStorage / IndexedDB / storage.local / storage.sync. This
 * module is the single place that will own that transition.
 */

export type SessionStatus = "locked" | "unlocked";

export interface SessionState {
  status: SessionStatus;
}

const state: SessionState = {
  status: "locked",
};

export function getSessionStatus(): SessionStatus {
  return state.status;
}
