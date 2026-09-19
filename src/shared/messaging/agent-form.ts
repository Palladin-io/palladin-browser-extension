/** Private value-free DOM registry vocabulary; no public form-write protocol. */
export const AGENT_FORM_INSPECT_CHANNEL = "palladin.agent-form/inspect" as const;
export const AGENT_FORM_LIMITS = { controls: 64, nodes: 10_000, lifetimeMs: 60_000 } as const;

export type AgentFormControlKind =
  | "text" | "email" | "password" | "tel" | "url" | "number"
  | "textarea" | "select" | "radio" | "checkbox" | "button";
export type AgentFormPurpose =
  | "username" | "new-password" | "current-password" | "confirm-password"
  | "one-time-code" | "email" | "name" | "given-name" | "family-name"
  | "organization" | "tel" | "country" | "postal-code" | "street-address";
export type AgentFormObstacle = "embedded-frame" | "captcha" | "unsupported-control";
export type AgentFormFailure =
  | "invalid-request" | "provider-unavailable" | "target-tab-unavailable"
  | "target-url-mismatch" | "insecure-origin" | "not-top-frame"
  | "stale-form" | "no-controls" | "form-too-large";

export interface AgentFormControl {
  readonly ref: string;
  readonly kind: AgentFormControlKind;
  readonly purpose: AgentFormPurpose | null;
  readonly required: boolean;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly hasPattern: boolean;
  readonly optionCount: number;
}

export interface AgentFormSnapshot {
  readonly snapshotId: string;
  readonly documentId: string;
  readonly controls: readonly AgentFormControl[];
  readonly obstacles: readonly AgentFormObstacle[];
}

export interface AgentFormInspectMessage {
  readonly channel: typeof AGENT_FORM_INSPECT_CHANNEL;
  readonly documentId: string;
  readonly targetUrl: string;
}

export type AgentFormInspection =
  | { readonly outcome: "ready"; readonly snapshot: AgentFormSnapshot }
  | { readonly outcome: AgentFormFailure };

