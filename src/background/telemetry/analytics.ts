/**
 * Reserved value-free analytics vocabulary. Extension telemetry is disabled.
 * Neither a project key nor an injected transport can enable capture. A future
 * release must implement an independently reviewed consent and withdrawal
 * contract before changing this gate (see docs/TELEMETRY.md).
 */

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

export const EXTENSION_TELEMETRY_RELEASED = false as const;

/** Reserved compatibility seam: deliberately does not retain a transport. */
export function setAnalyticsTransport(next: AnalyticsTransport | null): void {
  void next;
}

export function buildEventName(module: string, event: string): string {
  return `${ANALYTICS_COMPONENT}:${module}:${event}`;
}

/** A key is configuration, never consent or release authorization. */
export function isAnalyticsEnabled(): boolean {
  return EXTENSION_TELEMETRY_RELEASED;
}

export function capture<E extends string>(
  module: string,
  event: E & NonViewedEvent<E>,
  props?: AnalyticsProps,
): void {
  // No event object, identifiers, queue, storage access or network side effect.
  void module;
  void event;
  void props;
}
