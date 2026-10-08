export interface OrgGrant {
  id: string;
  vaultId: string;
  type: string;
  status: string;
  entryScopes: {
    entryId: string;
    fieldIds: string[];
    grantEnvelopeRevision: string | null;
    entryRevision: string | null;
    grantKeyVersion: number | null;
    memberKeyGeneration: number | null;
    recipientAgentKeyVersion: number | null;
    agentKeyFingerprint: string | null;
    fieldSelectionMode?: string;
    selectedFieldIds?: string[] | null;
  }[];
  scriptScopes: {
    entryId: string;
    entryRevision: string;
    isScript: boolean;
  }[];
  createdAt: string;
  grantedAt?: string | null;
  canRevoke: boolean;
  canGrantAgain: boolean;
  activeCoveringGrantIds: string[];
  vaultName?: string | null;
  agentId?: string | null;
  agentAccessEpoch?: number | null;
  agentName?: string | null;
  agentIconKey?: string | null;
  agentPublicKey?: string | null;
  recipientAgentKeyVersion?: number | null;
  agentSigningPublicKey?: string | null;
  agentSigningKeyVersion?: number | null;
  agentSigningKeyFingerprint?: string | null;
  methods?: string | null;
  entryId?: string | null;
  scriptEntryId?: string | null;
  entryLabel?: string | null;
  scriptPackageRevision?: string | null;
  reason?: string | null;
  encryptedReason?: unknown;
  expiresAt?: string | null;
  queryLimit?: number | null;
  queryCount?: number | null;
  expirySource?: string | null;
  createdBy?: string | null;
  createdByName?: string | null;
  revokedBy?: string | null;
  revokedByName?: string | null;
  supersededAt?: string | null;
  supersededByGrantId?: string | null;
  deniedBy?: string | null;
  deniedByName?: string | null;
  revokeReason?: string | null;
  denyReason?: string | null;
  lastAccessedAt?: string | null;
  lastAccessIp?: string | null;
  lastAccessHostname?: string | null;
}

export interface AuditLogItem {
  agentName?: string | null;
  actorName?: string | null;
  id: string;
  eventType: string;
  actorType: string;
  metadata: Record<string, string>;
  createdAt: string;
  userId?: string | null;
  agentId?: string | null;
  vaultId?: string | null;
  entryId?: string | null;
}

export type ShareRecipientMode = 'namedRecipient' | 'anyoneWithLink';
export type ShareProtection = 'none' | 'password' | 'pin';

export interface ShareCreationChallenge {
  shareId: string;
  sourceRevision: string;
  expiresAt: string;
}

export interface CreateEntryShareInput {
  shareId: string;
  sourceRevision: string;
  expiresAt: string;
  maximumReceipts: number | null;
  recipientMode: ShareRecipientMode;
  recipientEmail: string | null;
  protection: ShareProtection;
  protectionSecret: string | null;
  accessToken: string;
  nonce: string;
  ciphertext: string;
  notifyOnFirstReceipt: boolean;
}

export interface EntryShareListItem {
  shareId: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  maximumReceipts: number | null;
  deliveryCount: number;
  firstDeliveredAt: string | null;
  lastDeliveredAt: string | null;
  firstConfirmedAt: string | null;
  notifyOnFirstReceipt: boolean;
  recipientMode: string;
  recipientEmail: string | null;
  protection: string;
  sourceChanged: boolean;
}

export interface EntrySharesPage {
  items: EntryShareListItem[];
  nextCursor: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface MemberIdentity {
  userId: string;
  displayName: string;
}
