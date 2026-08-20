/**
 * Toolbar badge cleanup. The brand mark already contains a lock; Chromium's
 * tiny text badge obscures it and renders differently across platforms. Keep
 * the badge empty for every session state and show the authoritative state in
 * the popup header instead.
 *
 * {@link badgeForStatus} is pure so the mapping is unit-tested without a live
 * `chrome`; {@link applyBadge} adapts it onto the minimal {@link BadgeApi}.
 */

import type { SessionStatus } from "./session/types";

/** The slice of `chrome.action` the badge needs — kept tiny so tests fake it. */
export interface BadgeApi {
  setBadgeText(details: { text: string }): void | Promise<void>;
}

export interface BadgeState {
  readonly text: string;
}

export function badgeForStatus(_status: SessionStatus): BadgeState {
  return { text: "" };
}

export async function applyBadge(action: BadgeApi, status: SessionStatus): Promise<void> {
  await action.setBadgeText({ text: badgeForStatus(status).text });
}
