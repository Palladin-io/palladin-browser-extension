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
import { translate, type Translate, type TranslationKey } from "../i18n";

export type ErrorContext = "sign-in" | "totp" | "unlock";

/** Thrown by the {@link ./client.SessionClient} when the worker replies `ok:false`. */
export class PopupSessionError extends Error {
  constructor(readonly code: SessionErrorCode) {
    super(code);
    this.name = "PopupSessionError";
  }
}

const SHARED: Partial<Record<SessionErrorCode, TranslationKey>> = {
  network: "error.network",
  "rate-limited": "error.rateLimited",
  "no-account-material": "error.noAccountMaterial",
  "unsupported-security": "error.unsupportedSecurity",
  "not-authenticated": "error.sessionExpired",
};

const BY_CONTEXT: Record<ErrorContext, Partial<Record<SessionErrorCode, TranslationKey>>> = {
  "sign-in": {
    "invalid-credentials": "error.invalidSignIn",
    "incorrect-password": "error.invalidSignIn",
  },
  totp: {
    "invalid-credentials": "error.invalidTotp",
    "incorrect-password": "error.invalidTotp",
  },
  unlock: {
    "invalid-credentials": "error.invalidPassword",
    "incorrect-password": "error.invalidPassword",
    "not-authenticated": "error.sessionExpired",
  },
};

export function messageForError(
  error: unknown,
  context: ErrorContext,
  t: Translate = (key, values) => translate("en", key, values),
): string {
  if (!(error instanceof PopupSessionError)) return t("error.generic");
  return t(BY_CONTEXT[context][error.code] ?? SHARED[error.code] ?? "error.generic");
}
