/**
 * User-facing copy for a fill outcome. The worker returns a value-free
 * {@link FillResult}; the popup turns it into a short, plain-hyphen message
 * (never an em dash, never all-caps). Blocked reasons explain *why* so the user
 * can act (switch to HTTPS, open the right site) rather than see a generic fail.
 */

import type { FillBlockReason, FillResult } from "../../background/vault/commands";
import { translate, type Translate } from "../i18n";

export function fillMessage(
  result: FillResult,
  t: Translate = (key, values) => translate("en", key, values),
): string {
  switch (result.status) {
    case "filled":
      return t("fill.filled");
    case "no-form":
      return t("fill.noLoginForm");
    case "blocked":
      return blockedMessage(result.reason, t);
  }
}

function blockedMessage(reason: FillBlockReason, t: Translate): string {
  switch (reason) {
    case "insecure-page":
      return t("fill.insecure");
    case "domain-mismatch":
      return t("fill.domainMismatch");
    case "no-active-tab":
      return t("fill.noActiveTab");
    case "target-changed":
      return t("fill.targetChanged");
    case "locked":
      return t("fill.locked");
    case "not-fillable":
      return t("fill.notFillable");
    case "not-found":
    case "decrypt-failed":
    case "network":
    default:
      return t("fill.error");
  }
}
