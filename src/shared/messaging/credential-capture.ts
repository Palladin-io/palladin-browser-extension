export const CREDENTIAL_CAPTURE_CHANNEL = "palladin.credential-capture" as const;

export type CredentialSubmissionKind = "login" | "registration" | "password-change";

export interface SubmittedCredential {
  readonly kind: CredentialSubmissionKind;
  readonly username: string;
  readonly password: string;
  readonly previousPassword: string | null;
}

export type UsernameChoice = 'email' | 'nickname';
export interface CredentialSubmission extends SubmittedCredential {
  readonly usernameOptions?: Readonly<Record<UsernameChoice, string>>;
}

interface DocumentCommand {
  readonly channel: typeof CREDENTIAL_CAPTURE_CHANNEL;
  readonly documentId: string;
}

export type CredentialCaptureCommand = DocumentCommand & (
  | { readonly type: "identifier"; readonly submissionId: string; readonly username: string }
  | { readonly type: "submitted"; readonly submissionId: string; readonly credential: CredentialSubmission }
  | {
      readonly type: "outcome";
      readonly submissionId: string;
      readonly outcome: "rejected" | "form-dismissed" | "success-message";
    }
  | { readonly type: "resume"; readonly hasPasswordForm: boolean; readonly hasError: boolean; readonly hasSuccess: boolean }
  | { readonly type: "get" }
  | { readonly type: 'choose-username'; readonly promptId: string; readonly choice: UsernameChoice }
  | {
      readonly type: "save";
      readonly promptId: string;
      readonly targetId: string;
      readonly autoUpdate: boolean;
    }
  | { readonly type: "dismiss"; readonly promptId: string }
  | { readonly type: "mute"; readonly promptId: string }
  | { readonly type: "unlock" }
);

export interface CredentialCaptureTarget {
  readonly id: string;
  readonly action: "create" | "update";
  readonly label: string;
  readonly vaultLabel: string;
}

export interface CredentialCapturePrompt {
  readonly id: string;
  readonly site: string;
  readonly state: "locked" | "ready";
  readonly targets: readonly CredentialCaptureTarget[];
  readonly defaultTargetId: string | null;
  readonly error?: "save-failed";
  readonly usernameSelection?: { readonly selected: UsernameChoice | null };
}

export type CredentialCaptureResult =
  | { readonly status: "accepted" | "dismissed" | "unavailable" | "stale" }
  | { readonly status: "prompt"; readonly prompt: CredentialCapturePrompt | null }
  | { readonly status: "saved"; readonly action: "created" | "updated" };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

export function isSubmittedCredential(value: unknown): value is SubmittedCredential {
  if (!record(value) || !only(value, ["kind", "username", "password", "previousPassword"])) return false;
  return (value.kind === "login" || value.kind === "registration" || value.kind === "password-change")
    && boundedString(value.username, 0, 512)
    && boundedString(value.password, 1, 4096)
    && (value.previousPassword === null || boundedString(value.previousPassword, 1, 4096))
    && (value.kind === "password-change" || value.previousPassword === null);
}

export function isCredentialSubmission(value: unknown): value is CredentialSubmission {
  if (!record(value)) return false;
  if (!('usernameOptions' in value)) return isSubmittedCredential(value);
  const { usernameOptions, ...credential } = value;
  return isSubmittedCredential(credential) && credential.kind === 'registration' && credential.username === ''
    && record(usernameOptions) && only(usernameOptions, ['email', 'nickname'])
    && [usernameOptions.email, usernameOptions.nickname].every(option =>
      boundedString(option, 1, 512) && option.trim() === option)
    && usernameOptions.email !== usernameOptions.nickname;
}

export function isCredentialCaptureCommand(value: unknown): value is CredentialCaptureCommand {
  if (!record(value) || value.channel !== CREDENTIAL_CAPTURE_CHANNEL || !id(value.documentId)) return false;
  const base = ["channel", "documentId", "type"];
  switch (value.type) {
    case "identifier":
      return only(value, [...base, "submissionId", "username"])
        && id(value.submissionId) && boundedString(value.username, 1, 512) && value.username.trim() === value.username;
    case "submitted":
      return only(value, [...base, "submissionId", "credential"])
        && id(value.submissionId) && isCredentialSubmission(value.credential);
    case "outcome":
      return only(value, [...base, "submissionId", "outcome"]) && id(value.submissionId)
        && (value.outcome === "rejected" || value.outcome === "form-dismissed" || value.outcome === "success-message");
    case "resume":
      return only(value, [...base, "hasPasswordForm", "hasError", "hasSuccess"])
        && typeof value.hasPasswordForm === "boolean" && typeof value.hasError === "boolean"
        && typeof value.hasSuccess === "boolean";
    case "get":
    case "unlock":
      return only(value, base);
    case "save":
      return only(value, [...base, "promptId", "targetId", "autoUpdate"])
        && id(value.promptId) && id(value.targetId) && typeof value.autoUpdate === "boolean";
    case 'choose-username':
      return only(value, [...base, 'promptId', 'choice']) && id(value.promptId)
        && (value.choice === 'email' || value.choice === 'nickname');
    case "dismiss":
    case "mute":
      return only(value, [...base, "promptId"]) && id(value.promptId);
    default:
      return false;
  }
}

function isTarget(value: unknown): value is CredentialCaptureTarget {
  return record(value) && only(value, ["id", "action", "label", "vaultLabel"])
    && id(value.id) && (value.action === "create" || value.action === "update")
    && boundedString(value.label, 0, 4096) && boundedString(value.vaultLabel, 0, 4096);
}

export function isCredentialCaptureResult(value: unknown): value is CredentialCaptureResult {
  if (!record(value)) return false;
  switch (value.status) {
    case "accepted":
    case "dismissed":
    case "unavailable":
    case "stale":
      return only(value, ["status"]);
    case "saved":
      return only(value, ["status", "action"]) && (value.action === "created" || value.action === "updated");
    case "prompt": {
      if (!only(value, ["status", "prompt"])) return false;
      const prompt = value.prompt;
      return prompt === null || (record(prompt)
        && only(prompt, ["id", "site", "state", "targets", "defaultTargetId", "error", 'usernameSelection'])
        && (prompt.usernameSelection === undefined || (record(prompt.usernameSelection)
          && only(prompt.usernameSelection, ['selected']) && prompt.state === 'ready'
          && (prompt.usernameSelection.selected === null || prompt.usernameSelection.selected === 'email'
            || prompt.usernameSelection.selected === 'nickname')
          && (prompt.usernameSelection.selected !== null || (Array.isArray(prompt.targets)
            && prompt.targets.length === 0 && prompt.defaultTargetId === null))))
        && (prompt.error === undefined || prompt.error === "save-failed")
        && id(prompt.id) && boundedString(prompt.site, 1, 253)
        && (prompt.state === "locked" || prompt.state === "ready")
        && Array.isArray(prompt.targets) && prompt.targets.every(isTarget)
        && (prompt.defaultTargetId === null || prompt.targets.some((target) => target.id === prompt.defaultTargetId))
        && (prompt.state !== "locked" || (prompt.targets.length === 0 && prompt.defaultTargetId === null)));
    }
    default:
      return false;
  }
}
