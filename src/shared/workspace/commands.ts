import { z } from 'zod';
import type {
  AuditLogItem,
  EntrySharesPage,
  MemberIdentity,
  OrgGrant,
  Page,
} from './contracts';

const id = z.string().uuid();
const cursor = z.string().max(4096).optional();
const scope = { vaultId: id, entryId: id };
const policy = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('time'), expiresAt: z.string().datetime() })
    .strict(),
  z
    .object({
      kind: z.literal('uses'),
      queryLimit: z.number().int().min(1).max(2147483647),
    })
    .strict(),
  z.object({ kind: z.literal('lifetime') }).strict(),
]);
const protection = {
  protection: z.enum(['none', 'password', 'pin']),
  protectionSecret: z.string().max(128).nullable(),
};

// This is a browser-message boundary, not validation of first-party API state.
export const workspaceCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspace/grant-summary') }).strict(),
  z
    .object({
      type: z.literal('workspace/review-grant'),
      vaultId: id,
      grantId: id,
    })
    .strict(),
  z
    .object({
      type: z.literal('workspace/approve-grant'),
      vaultId: id,
      grantId: id,
      entryId: id,
      revision: z.string().regex(/^[1-9][0-9]{0,19}$/),
      methods: z.number().int().min(1).max(7),
      fields: z.array(z.string().min(1).max(160)).max(256),
      selection: z.enum(['all', 'selected']),
      policy,
    })
    .strict(),
  z.object({ type: z.literal('workspace/detail'), ...scope }).strict(),
  z
    .object({
      type: z.literal('workspace/field'),
      ...scope,
      fieldId: z.string().min(1).max(160),
    })
    .strict(),
  z
    .object({
      type: z.literal('workspace/create-share'),
      ...scope,
      operationId: id,
      hours: z.union([
        z.literal(1),
        z.literal(24),
        z.literal(72),
        z.literal(168),
      ]),
      maximumReceipts: z.number().int().min(1).max(100).nullable(),
      recipientEmail: z.string().email().max(320).nullable(),
      notifyOnFirstReceipt: z.boolean(),
      ...protection,
    })
    .strict(),
  z
    .object({ type: z.literal('workspace/discard-share'), operationId: id })
    .strict(),
  z
    .object({
      type: z.literal('workspace/grants'),
      cursor,
      status: z.string().max(32).optional(),
      entryId: id.optional(),
      vaultId: id.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('workspace/audit'),
      cursor,
      entryId: id.optional(),
      vaultId: id.optional(),
      eventType: z.string().max(120).optional(),
    })
    .strict(),
  z.object({ type: z.literal('workspace/members') }).strict(),
  z
    .object({
      type: z.literal('workspace/deny'),
      vaultId: id,
      grantId: id,
      reason: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('workspace/revoke-grant'),
      vaultId: id,
      grantId: id,
    })
    .strict(),
  z.object({ type: z.literal('workspace/shares'), ...scope, cursor }).strict(),
  z
    .object({
      type: z.literal('workspace/revoke-share'),
      ...scope,
      shareId: id,
    })
    .strict(),
  z
    .object({
      type: z.literal('workspace/protect-share'),
      ...scope,
      shareId: id,
      ...protection,
    })
    .strict(),
]);
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
export interface EntryFieldView {
  id: string;
  label: string;
  type: 'text' | 'multiline' | 'concealed' | 'totp';
  value: string | null;
}
export interface GrantReview {
  reason: string;
  grant: OrgGrant;
  entryId: string;
  revision: string;
  fields: { id: string; label: string }[];
  methods: number;
}
export interface WorkspaceResults {
  'workspace/grant-summary': {
    pending: number;
    active: number;
    expired: number;
    revoked: number;
    consumed: number;
    denied: number;
  };
  'workspace/review-grant': GrantReview;
  'workspace/approve-grant': null;
  'workspace/detail': { revision: string; fields: EntryFieldView[] };
  'workspace/field': { value: string; expiresIn?: number };
  'workspace/create-share': { url: string; shareId: string };
  'workspace/discard-share': null;
  'workspace/grants': Page<OrgGrant>;
  'workspace/audit': Page<AuditLogItem>;
  'workspace/members': { items: MemberIdentity[] };
  'workspace/deny': null;
  'workspace/revoke-grant': null;
  'workspace/shares': EntrySharesPage;
  'workspace/revoke-share': null;
  'workspace/protect-share': null;
}
export type WorkspaceErrorCode =
  'locked' | 'network' | 'forbidden' | 'conflict' | 'invalid';
export type WorkspaceReply =
  | { ok: true; data: WorkspaceResults[keyof WorkspaceResults] }
  | { ok: false; code: WorkspaceErrorCode };
