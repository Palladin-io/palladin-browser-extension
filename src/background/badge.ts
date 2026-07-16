/**
 * Toolbar badge that mirrors the session lock state, so the user reads
 * locked-vs-unlocked from the tray without opening the popup.
 *
 * A padlock glyph sits on the icon whenever the session is NOT unlocked
 * (locked or signed-out — both are "closed" from the user's point of view);
 * unlocking clears it so the plain brand mark reads as "open and ready". The
 * badge carries no secret and no per-entry count — only the coarse state.
 *
 * {@link badgeForStatus} is pure so the mapping is unit-tested without a live
 * `chrome`; {@link applyBadge} adapts it onto the minimal {@link BadgeApi}.
 */

import type { SessionStatus } from "./session/types";

/** The slice of `chrome.action` the badge needs — kept tiny so tests fake it. */
export interface BadgeApi {
  setBadgeText(details: { text: string }): void | Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): void | Promise<void>;
}

/** Padlock shown while the session is locked or signed-out. */
const LOCK_GLYPH = "🔒";

/** Neutral chip behind the glyph — mirrors the web panel `--cv-neutral`. */
const NEUTRAL_BG = "#8A95A6";

export interface BadgeState {
  readonly text: string;
  readonly color: string;
}

export function badgeForStatus(status: SessionStatus): BadgeState {
  // Unlocked = clean icon (no chip); anything else wears the padlock.
  const text = status === "unlocked" ? "" : LOCK_GLYPH;
  return { text, color: NEUTRAL_BG };
}

export async function applyBadge(action: BadgeApi, status: SessionStatus): Promise<void> {
  const { text, color } = badgeForStatus(status);
  // Colour first so the chip never flashes a stale colour behind a new glyph.
  await action.setBadgeBackgroundColor({ color });
  await action.setBadgeText({ text });
}
