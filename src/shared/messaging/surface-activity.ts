/** Private extension-page input signal; never accepted by the page/content bridge. */
export interface SurfaceActivity {
  readonly channel: "palladin.session/activity";
  readonly type: "activity";
  readonly observedAt: number;
}
export function isSurfaceActivity(value: unknown): value is SurfaceActivity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).sort().join(",") === "channel,observedAt,type"
    && candidate.channel === "palladin.session/activity" && candidate.type === "activity"
    && Number.isSafeInteger(candidate.observedAt) && (candidate.observedAt as number) >= 0;
}
