import type { SharedUnlockContext, SharedUnlockKeyContext } from "@palladin/crypto";
import type { AuthResponse } from "../session/auth-client";

export interface SharedUnlockPreference {
  readonly sharedUnlockEnabled: boolean;
  readonly revision: number;
}

export interface SharedUnlockLink {
  readonly linkId: string;
  readonly revision: number;
  readonly epoch: number;
  readonly state: "locked" | "active" | "revoked";
  readonly lastInvalidationSequence: number;
  readonly lastLogoutSequence: number;
}

export interface SharedUnlockAuthorization {
  readonly authorizationId: string;
  readonly sequence: number;
  readonly accountId: string;
  readonly organizationId: string;
  readonly credentialRevision: number;
  readonly privateKeyWrapRevision: number;
  readonly authorizationVersion: number;
  readonly unlockedAtMs: number;
  readonly idleDeadlineMs: number;
  readonly absoluteDeadlineMs: number;
  readonly offlineDeadlineMs: number;
}

export interface SharedUnlockOperation {
  readonly context: SharedUnlockContext;
  readonly sourcePublicKey: string;
  readonly recipientPublicKey: string;
  readonly recipientProofPublicKey: string;
  readonly challenge: string;
  readonly transcriptHash: string;
  readonly keyContext: SharedUnlockKeyContext;
}

export interface SharedUnlockSession extends AuthResponse {
  readonly emailVerified: boolean;
  readonly waitlistDeveloperBenefitStartedAt: string | null;
  readonly waitlistDeveloperBenefitEndsAt: string | null;
}

export interface SharedUnlockCommit {
  readonly session: SharedUnlockSession;
  readonly authorizationId: string;
  readonly authorizationSequence: number;
  readonly context: SharedUnlockContext;
}

export interface SharedUnlockManualInput {
  readonly authCredential: string;
  readonly sourceGeneration: string;
  readonly expectedPreferenceRevision: number;
  readonly expectedCredentialRevision: number;
  readonly expectedPrivateKeyWrapRevision: number;
  readonly idleDeadlineMs: number;
  readonly absoluteDeadlineMs: number;
  readonly offlineDeadlineMs: number;
}

export interface SharedUnlockActivityInput {
  readonly authorizationId: string;
  readonly sourceGeneration: string;
  readonly idleDeadlineMs: number;
}

export interface SharedUnlockActivationInput {
  readonly authorizationId: string;
  readonly sourceGeneration: string;
  readonly expectedRevision: number;
  readonly expectedPreferenceRevision: number;
}

export interface SharedUnlockOperationInput {
  readonly authorizationId: string;
  readonly linkId: string;
  readonly linkEpoch: number;
  readonly expectedPreferenceRevision: number;
  readonly recipientOrganizationId: string;
  readonly direction: SharedUnlockContext["direction"];
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly extensionId: string;
  readonly documentBinding: string;
  readonly webGeneration: string;
  readonly extensionGeneration: string;
  readonly sourcePublicKey: string;
  readonly recipientPublicKey: string;
  readonly recipientProofPublicKey: string;
}
