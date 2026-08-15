/**
 * User-facing copy for a fill outcome. The worker returns a value-free
 * {@link FillResult}; the popup turns it into a short, plain-hyphen message
 * (never an em dash, never all-caps). Blocked reasons explain *why* so the user
 * can act (switch to HTTPS, open the right site) rather than see a generic fail.
 */

import type { FillBlockReason, FillResult } from "../../background/vault/commands";

export function fillMessage(result: FillResult): string {
  switch (result.status) {
    case "filled":
      return "Filled";
    case "no-form":
      return "No login form found";
    case "blocked":
      return blockedMessage(result.reason);
  }
}

function blockedMessage(reason: FillBlockReason): string {
  switch (reason) {
    case "insecure-page":
      return "Fill only works on HTTPS pages";
    case "domain-mismatch":
      return "This entry is not for the current site";
    case "no-active-tab":
      return "No active tab to fill";
    case "target-changed":
      return "The page changed - try again";
    case "locked":
      return "Locked - reopen to unlock";
    case "not-fillable":
      return "This entry has no login to fill";
    case "not-found":
    case "decrypt-failed":
    case "network":
    default:
      return "Could not fill this entry";
  }
}
