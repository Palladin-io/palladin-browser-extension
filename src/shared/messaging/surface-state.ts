import type { SessionStatus } from "../../background/session/types";

export const SURFACE_STATE_CHANNEL = "palladin.surface-state.v1" as const;

export type SurfaceStateEvent =
  | {
      readonly channel: typeof SURFACE_STATE_CHANNEL;
      readonly type: "surface/session-changed";
      readonly status: SessionStatus;
    }
  | {
      readonly channel: typeof SURFACE_STATE_CHANNEL;
      readonly type: "surface/vault-changed";
    };

export function sessionChanged(status: SessionStatus): SurfaceStateEvent {
  return { channel: SURFACE_STATE_CHANNEL, type: "surface/session-changed", status };
}

export function vaultChanged(): SurfaceStateEvent {
  return { channel: SURFACE_STATE_CHANNEL, type: "surface/vault-changed" };
}

export function isSurfaceStateEvent(value: unknown): value is SurfaceStateEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SurfaceStateEvent>;
  if (candidate.channel !== SURFACE_STATE_CHANNEL) return false;
  const keys = Object.keys(value);
  if (candidate.type === "surface/vault-changed") return keys.length === 2;
  return candidate.type === "surface/session-changed"
    && keys.length === 3
    && (candidate.status === "signed-out"
      || candidate.status === "locked"
      || candidate.status === "unlocked");
}
