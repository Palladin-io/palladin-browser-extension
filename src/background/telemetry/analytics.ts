/**
 * Extension analytics — the `ex:` component of the Palladin
 * `{component}:{module}:{event}` convention (see root AGENTS.md → Analytics).
 *
 * `capture(module, event, props?)` builds `ex:{module}:{event}` and forwards it
 * to the active transport. Two hard rules, both enforced here:
 *   1. **UI-only, never `*-viewed`.** Screen/tab views are covered generically;
 *      the type makes an event name ending in `-viewed` a compile error.
 *   2. **No-op without a PostHog key.** With no key configured the call is a
 *      pure no-op — no network, no queue — so a dev build never phones home.
 *
 * The wire transport (HTTP capture) lands with the popup/analytics wiring
 * (CVT-375/376); today the default transport is a no-op and `capture` is a
 * typed, tested seam that other modules can already call.
 */

import { env } from "../config/env";

export const ANALYTICS_COMPONENT = "ex" as const;

/** Compile-time ban on `*-viewed` event names (rule 5, Analytics Convention). */
export type NonViewedEvent<E extends string> = E extends `${string}-viewed`
  ? never
  : E;

export type AnalyticsProps = Readonly<Record<string, string | number | boolean>>;

export interface AnalyticsEvent {
  /** Fully-qualified name, e.g. `ex:vault:autofill-used`. */
  readonly name: string;
  readonly props?: AnalyticsProps;
}

export type AnalyticsTransport = (event: AnalyticsEvent) => void;

let transport: AnalyticsTransport | null = null;

/**
 * Install the transport that actually delivers events (wired once the PostHog
 * capture client exists). Injectable so tests can observe emitted events.
 */
export function setAnalyticsTransport(next: AnalyticsTransport | null): void {
  transport = next;
}

export function buildEventName(module: string, event: string): string {
  return `${ANALYTICS_COMPONENT}:${module}:${event}`;
}

/** True when analytics can emit (a PostHog key is configured). */
export function isAnalyticsEnabled(): boolean {
  return env.posthogKey.length > 0;
}

export function capture<E extends string>(
  module: string,
  event: E & NonViewedEvent<E>,
  props?: AnalyticsProps,
): void {
  if (!isAnalyticsEnabled() || transport === null) return;
  transport(props ? { name: buildEventName(module, event), props } : { name: buildEventName(module, event) });
}
