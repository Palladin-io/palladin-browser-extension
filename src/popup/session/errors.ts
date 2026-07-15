/**
 * Turn a typed {@link SessionErrorCode} from the worker into a friendly,
 * value-free message for the popup. The worker never sends secret material in an
 * error, and neither do we: messages describe the situation, never the input.
 *
 * A few codes read differently depending on where the user is (a bad code on the
 * TOTP step vs. a bad password on unlock), so the mapping is keyed by the form
 * {@link ErrorContext} that raised it.
 */

import type { SessionErrorCode } from "../../background/session/types";

export type ErrorContext = "sign-in" | "totp" | "unlock";

/** Thrown by the {@link ./client.SessionClient} when the worker replies `ok:false`. */
export class PopupSessionError extends Error {
  constructor(readonly code: SessionErrorCode) {
    super(code);
    this.name = "PopupSessionError";
  }
}

const GENERIC = "Something went wrong. Try again.";

const SHARED: Partial<Record<SessionErrorCode, string>> = {
  network: "Can't reach Palladin. Check your connection and try again.",
  "no-account-material":
    "This account isn't set up for unlock yet. Finish setup in the web panel.",
  "not-authenticated": "Your session has expired. Sign in again.",
};

const BY_CONTEXT: Record<ErrorContext, Partial<Record<SessionErrorCode, string>>> = {
  "sign-in": {
    "invalid-credentials": "Incorrect email or master password.",
    "incorrect-password": "Incorrect email or master password.",
  },
  totp: {
    "invalid-credentials": "That code didn't match. Try again.",
    "incorrect-password": "That code didn't match. Try again.",
  },
  unlock: {
    "invalid-credentials": "Incorrect master password.",
    "incorrect-password": "Incorrect master password.",
    "not-authenticated": "Your session has expired. Sign in again.",
  },
};

export function messageForError(error: unknown, context: ErrorContext): string {
  if (!(error instanceof PopupSessionError)) return GENERIC;
  return BY_CONTEXT[context][error.code] ?? SHARED[error.code] ?? GENERIC;
}
