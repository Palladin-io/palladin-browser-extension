import { z } from "zod";

const key = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const uuid = z.string().uuid();
const uint = z.number().int().min(0).max(0xffff_ffff);
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(2048);
const context = z.object({ protocol: z.literal("palladin.shared-unlock.v1"), direction: z.enum(["web-to-extension", "extension-to-web"]),
  operationId: uuid, accountId: uuid, organizationId: uuid, apiOrigin: text, webOrigin: text, extensionId: z.string().min(1).max(256),
  documentBinding: z.string().min(1).max(256), webGeneration: key, extensionGeneration: key, linkId: uuid,
  linkEpoch: uint, preferenceRevision: uint, authorizationVersion: uint, keyContextDigest: key,
  issuedAtMs: time, expiresAtMs: time, unlockedAtMs: time, idleDeadlineMs: time, absoluteDeadlineMs: time, offlineDeadlineMs: time }).strict();
const keyContext = z.object({ accountId: uuid, securityVersion: uint, minimumSecurityVersion: uint,
  kdfProfileId: z.string().min(1).max(128), kdfSalt: z.string().min(1).max(128), credentialRevision: uint,
  privateKeyWrapRevision: uint, memberKeyVersion: uint, publicKey: key,
  encryptedPrivateKey: z.string().min(1).max(5462).regex(/^[A-Za-z0-9_-]+$/) }).strict();
const operation = z.object({ context, sourcePublicKey: key, recipientPublicKey: key, recipientProofPublicKey: key,
  challenge: key, transcriptHash: key, keyContext }).strict();
const envelope = z.object({ protocol: z.literal("palladin.shared-unlock.v1"), suite: z.literal("X25519-HKDF-SHA256-XCHACHA20POLY1305"),
  context, sourcePublicKey: key, recipientPublicKey: key, nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{64}$/) }).strict();

/** Independent browser input boundary. Identity REST remains typed; crypto
 * binding and commitments still belong to the source/receiver SDK transaction. */
const payloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("link-invalidated") }).strict(),
  z.object({ kind: z.literal("state"), stateId: key, accountId: uuid.nullable(),
    status: z.enum(["signed-out", "locked", "unlocked"]), generation: key,
    source: z.object({ organizationId: uuid }).strict().nullable() }).strict(),
  z.object({ kind: z.literal("link"), webStateId: key, extensionStateId: key, accountId: uuid, linkId: uuid }).strict(),
  z.object({ kind: z.literal("link-selected"), webStateId: key, extensionStateId: key, accountId: uuid, linkId: uuid }).strict(),
  z.object({ kind: z.literal("prepare"), webStateId: key, extensionStateId: key, accountId: uuid,
    organizationId: uuid, linkId: uuid, linkEpoch: uint, preferenceRevision: uint }).strict(),
  z.object({ kind: z.literal("prepared") }).strict(),
  z.object({ kind: z.literal("source-offer"), publicKey: key }).strict(),
  z.object({ kind: z.literal("receiver-offer"), publicKey: key, proofPublicKey: key }).strict(),
  z.object({ kind: z.literal("handoff"), operation, envelope }).strict(),
  z.object({ kind: z.literal("ack"), operationId: uuid, webGeneration: key, extensionGeneration: key }).strict(),
  z.object({ kind: z.literal("cancel") }).strict(),
]);
export const sharedUnlockOperationSchema = z.object({ attemptId: key, payload: payloadSchema }).strict();
export type SharedUnlockOperationMessage = z.infer<typeof sharedUnlockOperationSchema>;
export const sharedUnlockOperationFrameSchema = z.object({ type: z.literal("operation"),
  protocol: z.literal("palladin.shared-unlock.browser.v1"), apiUrl: text, webNonce: key, channelId: key,
  documentBinding: z.string().min(1).max(256), attemptId: key, payload: payloadSchema }).strict();
export type SharedUnlockOperationFrame = z.infer<typeof sharedUnlockOperationFrameSchema>;
