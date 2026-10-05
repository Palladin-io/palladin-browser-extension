import { encryptedReasonEnvelopeSchema } from '../vault/protocol2/entry-envelope-schema';
import { buildVaultScriptPackage } from '../vault/protocol2/script-package';
import {
  openEncryptedReason,
  generateTotp,
  parseOtpauthUri,
  buildCanonicalGrantEnvelope,
  listCanonicalGrantableFieldIds,
  GRANT_DELIVERY_POLICY,
  type currentVaultPlaintext,
  createEntryShareSnapshot,
  entryShareFields,
  entryShareFragment,
  entrySharePath,
  prepareEntryShare,
  toBase64Url,
  wipe,
  openVaultProjection,
  openCurrentMemberSecret,
} from '@palladin/crypto';
import type {
  WorkspaceCommand,
  WorkspaceReply,
} from '../../shared/workspace/commands';
import type {
  OrgGrant,
  CreateEntryShareInput,
  ShareCreationChallenge,
} from '../../shared/workspace/contracts';
import type { Protocol2VaultClient } from '../vault/protocol2/client';
import type { Protocol2VaultDataService, Protocol2SessionAccessor } from '../vault/protocol2/service';
import { WorkspaceError, type WorkspaceOperation } from './service';

interface PendingShare {
  scope: string;
  input: CreateEntryShareInput;
  url: string;
  createdAt: number;
}
export class EntryActions {
  private readonly pendingShares = new Map<string, PendingShare>();
  private readonly inFlight = new Map<string, Promise<WorkspaceReply | null>>();
  private readonly cancelled = new Set<string>();
  constructor(
    private readonly deps: {
      client: Pick<Protocol2VaultClient, 'getVault' | 'getEntry'>;
      session: Protocol2SessionAccessor;
      data: Pick<Protocol2VaultDataService, 'revealCurrentEntry'>;
      webUrl: string;
    },
  ) {}
  clear(): void {
    this.pendingShares.clear();
    this.inFlight.clear();
    this.cancelled.clear();
  }

  async handle(
    command: WorkspaceCommand,
    operation: WorkspaceOperation,
  ): Promise<WorkspaceReply | null> {
    if (command.type === 'workspace/discard-share') {
      if (this.inFlight.has(command.operationId))
        this.cancelled.add(command.operationId);
      this.pendingShares.delete(command.operationId);
      return { ok: true, data: null };
    }
    if (command.type !== 'workspace/create-share')
      return this.execute(command, operation);
    const existing = this.inFlight.get(command.operationId);
    if (existing) throw new WorkspaceError('conflict');
    const assertCurrent = () => {
      operation.assertCurrent();
      if (this.cancelled.has(command.operationId))
        throw new WorkspaceError('locked');
    };
    const pending = this.execute(command, {
      ...operation,
      assertCurrent,
      request: async (path, method, body) => {
        assertCurrent();
        const response = await operation.request(path, method, body);
        assertCurrent();
        return response;
      },
    });
    this.inFlight.set(command.operationId, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(command.operationId);
      this.cancelled.delete(command.operationId);
    }
  }

  private async execute(
    command: WorkspaceCommand,
    operation: WorkspaceOperation,
  ): Promise<WorkspaceReply | null> {
    if (command.type === 'workspace/grant-reason') return this.grantReason(command, operation);
    if (
      command.type === 'workspace/review-grant' ||
      command.type === 'workspace/approve-grant'
    )
      return this.grant(command, operation);
    if (command.type === 'workspace/discard-share') {
      this.pendingShares.delete(command.operationId);
      return { ok: true, data: null };
    }
    if (
      command.type !== 'workspace/detail' &&
      command.type !== 'workspace/field' &&
      command.type !== 'workspace/create-share'
    )
      return null;
    if (command.type === 'workspace/create-share') {
      for (const [id, share] of this.pendingShares)
        if (Date.now() - share.createdAt > 15 * 60_000)
          this.pendingShares.delete(id);
      const pending = this.pendingShares.get(command.operationId);
      if (pending) {
        if (pending.scope !== JSON.stringify(command))
          throw new WorkspaceError('invalid');
        return this.submitShare(command, pending, operation);
      }
      if (this.pendingShares.size >= 20) throw new WorkspaceError('invalid');
    }
    if (command.type === 'workspace/detail' || command.type === 'workspace/field') {
      operation.assertCurrent();
      const secret = await this.deps.data.revealCurrentEntry(command.vaultId, command.entryId);
      operation.assertCurrent();
      const fields = entryShareFields(secret).fields;
      if (command.type === 'workspace/detail') return {
        ok: true,
        data: { fields: fields.map(field => ({ ...field, value: field.type === 'concealed' || field.type === 'totp' ? null : field.value })) },
      };
      const field = fields.find(field => field.id === command.fieldId);
      if (!field) throw new WorkspaceError('invalid');
      const params = field.type === 'totp' ? parseOtpauthUri(field.value) : null;
      if (field.type === 'totp' && !params) throw new WorkspaceError('invalid');
      const code = params ? await generateTotp(params) : null;
      operation.assertCurrent();
      return { ok: true, data: { value: code?.code ?? field.value, ...(code ? { expiresIn: code.expiresIn } : {}) } };
    }
    return this.withEntry(
      command,
      operation,
      async ({ vault, detail, secret }) => {
        const challenge = (await operation.request(
          `${this.path(command)}/creation-challenge`,
          'POST',
          {},
        )) as ShareCreationChallenge;
        if (challenge.sourceRevision !== detail.currentRevision)
          throw new WorkspaceError('conflict');
        const expiresAt = new Date(
          Date.now() + command.hours * 3_600_000,
        ).toISOString();
        const material = await prepareEntryShare(
          {
            organizationId: vault.organizationId,
            vaultId: command.vaultId,
            entryId: command.entryId,
            shareId: challenge.shareId,
            sourceRevision: challenge.sourceRevision,
            expiresAt,
          },
          createEntryShareSnapshot(secret),
        );
        try {
          operation.assertCurrent();
          const pending: PendingShare = {
            scope: JSON.stringify(command),
            createdAt: Date.now(),
            input: {
              shareId: challenge.shareId,
              sourceRevision: challenge.sourceRevision,
              expiresAt,
              maximumReceipts: command.maximumReceipts,
              recipientMode: command.recipientEmail
                ? 'namedRecipient'
                : 'anyoneWithLink',
              recipientEmail: command.recipientEmail,
              protection: command.protection,
              protectionSecret:
                command.protection === 'none' ? null : command.protectionSecret,
              notifyOnFirstReceipt: command.notifyOnFirstReceipt,
              nonce: material.nonce,
              ciphertext: material.ciphertext,
              accessToken: toBase64Url(material.accessToken),
            },
            url: `${this.deps.webUrl}${entrySharePath(challenge.shareId)}${entryShareFragment(material)}`,
          };
          this.pendingShares.set(command.operationId, pending);
          return await this.submitShare(command, pending, operation);
        } finally {
          wipe(material.key);
          wipe(material.accessToken);
        }
      },
    );
  }

  private async grantReason(
    command: Extract<WorkspaceCommand, { type: 'workspace/grant-reason' }>,
    operation: WorkspaceOperation,
  ): Promise<WorkspaceReply> {
    const grant = await operation.request(`/api/vaults/${command.vaultId}/grants/${command.grantId}`, 'GET') as OrgGrant;
    if (grant.id !== command.grantId || grant.vaultId !== command.vaultId) throw new WorkspaceError('invalid');
    if (!grant.encryptedReason) return { ok: true, data: { reason: null } };
    const envelope = encryptedReasonEnvelopeSchema.safeParse(grant.encryptedReason);
    if (!envelope.success || !grant.agentId || !grant.agentSigningPublicKey || !grant.agentSigningKeyVersion || !grant.agentSigningKeyFingerprint) throw new WorkspaceError('reason-contract');
    const privateKey = this.deps.session.getPrivateKey();
    const userId = await this.deps.session.getUserId();
    const token = await this.deps.session.getAccessToken();
    operation.assertCurrent();
    if (!privateKey || !userId || !token) throw new WorkspaceError('locked');
    const vault = await this.deps.client.getVault(token, command.vaultId, operation.signal);
    operation.assertCurrent();
    if (vault.id !== command.vaultId) throw new WorkspaceError('invalid');
    const opened = await openVaultProjection(vault, privateKey, userId).catch(() => { throw new WorkspaceError('reason-key'); });
    try {
      operation.assertCurrent();
      // Historical reasons use their signed key version; authenticated grant/Vault state supplies scope authority.
      const reason = await openEncryptedReason(envelope.data, vault.vaultPrivateKeys, opened.vaultKey, {
        publicKey: grant.agentSigningPublicKey,
        keyVersion: grant.agentSigningKeyVersion,
        keyFingerprint: grant.agentSigningKeyFingerprint,
      }, {
        organizationId: vault.organizationId,
        vaultId: command.vaultId,
        grantId: command.grantId,
        agentId: grant.agentId,
        ...(grant.entryId ?? grant.scriptEntryId ? { entryId: (grant.entryId ?? grant.scriptEntryId)! } : {}),
      }).catch(() => { throw new WorkspaceError('reason-proof'); });
      operation.assertCurrent();
      return { ok: true, data: { reason } };
    } finally { wipe(opened.vaultKey); }
  }

  private async grant(
    command: Extract<
      WorkspaceCommand,
      { type: 'workspace/review-grant' | 'workspace/approve-grant' }
    >,
    operation: WorkspaceOperation,
  ): Promise<WorkspaceReply> {
    const grant = (await operation.request(
      `/api/vaults/${command.vaultId}/grants/${command.grantId}`,
      'GET',
    )) as OrgGrant;
    if (
      grant.id !== command.grantId ||
      grant.vaultId !== command.vaultId ||
      !grant.agentId
    )
      throw new WorkspaceError('invalid');
    const entryId =
      grant.type === 'scriptExecution'
        ? (grant.scriptEntryId ?? grant.entryId)
        : grant.entryId;
    if (
      !entryId ||
      (grant.type !== 'granular' && grant.type !== 'scriptExecution')
    )
      throw new WorkspaceError('invalid');
    return this.withEntry(
      { vaultId: command.vaultId, entryId },
      operation,
      async ({ vault, detail, secret, vaultKey }) => {
        const requestedMethods = methodsMask(grant.methods);
        const fieldIds = listCanonicalGrantableFieldIds(secret);
        if (
          command.type === 'workspace/approve-grant' &&
          (command.entryId !== entryId ||
            command.revision !== detail.currentRevision)
        )
          throw new WorkspaceError('conflict');
        if (
          command.type === 'workspace/approve-grant' &&
          ((command.methods & requestedMethods) !== command.methods ||
            secret.entryType === 'creditCard')
        )
          throw new WorkspaceError('invalid');
        const reasonEnvelope = encryptedReasonEnvelopeSchema.safeParse(
          grant.encryptedReason,
        );
        if (
          !reasonEnvelope.success ||
          !grant.agentSigningPublicKey ||
          !grant.agentSigningKeyVersion ||
          !grant.agentSigningKeyFingerprint ||
          reasonEnvelope.data.descriptor.binding.requestedMethods !==
            requestedMethods ||
          reasonEnvelope.data.descriptor.binding.recipientKeyVersion !==
            vault.currentKeyEpoch.agentMessageKeyVersion
        )
          throw new WorkspaceError('invalid');
        const reason = await openEncryptedReason(
          reasonEnvelope.data,
          vault.vaultPrivateKeys,
          vaultKey,
          {
            publicKey: grant.agentSigningPublicKey,
            keyVersion: grant.agentSigningKeyVersion,
            keyFingerprint: grant.agentSigningKeyFingerprint,
          },
          {
            organizationId: vault.organizationId,
            vaultId: command.vaultId,
            entryId,
            grantId: command.grantId,
            agentId: grant.agentId!,
          },
        );
        operation.assertCurrent();
        if (command.type === 'workspace/review-grant')
          return {
            ok: true,
            data: {
              grant,
              reason,
              entryId,
              revision: detail.currentRevision,
              methods: requestedMethods,
              fields: fieldIds.map((id) => ({
                id,
                label:
                  secret.content.customFields.find((field) => field.id === id)
                    ?.label ?? id,
              })),
            },
          };
        const policy =
          command.policy.kind === 'time'
            ? { expiresAt: command.policy.expiresAt }
            : command.policy.kind === 'uses'
              ? { queryLimit: command.policy.queryLimit }
              : {};
        if (
          command.policy.kind === 'time' &&
          Date.parse(command.policy.expiresAt) <= Date.now()
        )
          throw new WorkspaceError('invalid');
        const agent = (await operation.request(
          `/api/agents/${grant.agentId}`,
          'GET',
        )) as {
          agentId: string;
          publicKey: string | null;
          recipientKeyVersion: number;
          accessEpoch: number;
        };
        if (agent.agentId !== grant.agentId || !agent.publicKey)
          throw new WorkspaceError('invalid');
        let material: object;
        if (grant.type === 'scriptExecution') {
          if (command.methods !== 2) throw new WorkspaceError('invalid');
          material = {
            scriptPackage: await buildVaultScriptPackage({
              vault,
              vaultKey,
              scriptEntryId: entryId,
              scriptRevision: detail.currentRevision,
              secret,
              agentId: grant.agentId!,
              agentPublicKey: agent.publicKey,
              recipientKeyVersion: agent.recipientKeyVersion,
              agentAccessEpoch: agent.accessEpoch,
              grantId: grant.id,
              packageRevision: '1',
              open: async (id) =>
                this.withEntry(
                  { vaultId: vault.id, entryId: id },
                  operation,
                  async ({ secret, detail }) => ({
                    secret,
                    revision: detail.currentRevision,
                  }),
                ),
            }),
          };
        } else {
          const selected = new Set(command.fields);
          if (
            !selected.size ||
            selected.size !== command.fields.length ||
            command.fields.some((id) => !fieldIds.includes(id)) ||
            (command.selection === 'all' && selected.size !== fieldIds.length)
          )
            throw new WorkspaceError('invalid');
          material = {
            grantEntry: await buildCanonicalGrantEnvelope({
              secret,
              organizationId: vault.organizationId,
              vaultId: command.vaultId,
              entryId,
              grantId: grant.id,
              agentId: grant.agentId!,
              agentPublicKey: agent.publicKey,
              entryRevision: detail.currentRevision,
              grantEnvelopeRevision: '1',
              grantKeyVersion: 1,
              recipientKeyVersion: agent.recipientKeyVersion,
              memberKeyGeneration: vault.memberKeyGeneration,
              approvedFieldIds: command.fields,
              approvedMethods: command.methods,
              deliveryPolicy: GRANT_DELIVERY_POLICY[detail.deliveryPolicy],
              ...policy,
              ...(command.policy.kind === 'uses'
                ? { remainingUses: command.policy.queryLimit }
                : {}),
            }),
            fieldSelectionMode: command.selection,
          };
        }
        operation.assertCurrent();
        const latest = (await operation.request(
          `/api/vaults/${command.vaultId}/entries/${entryId}`,
          'GET',
        )) as { currentRevision: string };
        if (latest.currentRevision !== command.revision)
          throw new WorkspaceError('conflict');
        await operation.request(
          `/api/vaults/${command.vaultId}/grants/${command.grantId}/approve`,
          'PUT',
          {
            ...material,
            ...policy,
            methods: (['Get', 'Exec', 'Inject'] as const)
              .filter((_, index) => command.methods & (1 << index))
              .join(', '),
          },
        );
        return { ok: true, data: null };
      },
    );
  }

  private async submitShare(
    command: { vaultId: string; entryId: string },
    pending: PendingShare,
    operation: WorkspaceOperation,
  ): Promise<WorkspaceReply> {
    await operation.request(this.path(command), 'POST', pending.input);
    return {
      ok: true,
      data: { url: pending.url, shareId: pending.input.shareId },
    };
  }

  private path(scope: { vaultId: string; entryId: string }): string {
    return `/api/vaults/${scope.vaultId}/entries/${scope.entryId}/sharing`;
  }

  private async withEntry<T>(
    scope: { vaultId: string; entryId: string },
    operation: WorkspaceOperation,
    use: (entry: {
      vault: Awaited<ReturnType<Protocol2VaultClient['getVault']>>;
      detail: Awaited<ReturnType<Protocol2VaultClient['getEntry']>>;
      secret: currentVaultPlaintext.MemberSecretV1;
      vaultKey: Uint8Array;
    }) => Promise<T>,
  ) {
    const privateKey = this.deps.session.getPrivateKey();
    const userId = await this.deps.session.getUserId();
    operation.assertCurrent();
    if (!privateKey || !userId) throw new WorkspaceError('locked');
    const token = await this.deps.session.getAccessToken();
    if (!token) throw new WorkspaceError('locked');
    operation.assertCurrent();
    const [vault, detail] = await Promise.all([
      this.deps.client.getVault(token, scope.vaultId, operation.signal),
      this.deps.client.getEntry(
        token,
        scope.vaultId,
        scope.entryId,
        operation.signal,
      ),
    ]);
    operation.assertCurrent();
    // The authenticated Vault projection supplies organization authority; request IDs supply Vault/Entry authority.
    if (
      vault.id !== scope.vaultId ||
      detail.vaultId !== scope.vaultId ||
      detail.id !== scope.entryId ||
      detail.organizationId !== vault.organizationId
    )
      throw new WorkspaceError('invalid');
    const opened = await openVaultProjection(vault, privateKey, userId);
    try {
      operation.assertCurrent();
      const secret = await openCurrentMemberSecret(
        detail.entryKey,
        detail.memberSecret,
        opened.vaultKey,
        {
          organizationId: vault.organizationId,
          vaultId: scope.vaultId,
          entryId: scope.entryId,
          revision: detail.currentRevision,
        },
      );
      operation.assertCurrent();
      return await use({ vault, detail, secret, vaultKey: opened.vaultKey });
    } finally {
      wipe(opened.vaultKey);
    }
  }
}

function methodsMask(value: string | null | undefined): number {
  const bits: Record<string, number> = { get: 1, exec: 2, inject: 4 };
  return (value ?? '')
    .split(',')
    .reduce(
      (mask, method) => mask | (bits[method.trim().toLowerCase()] ?? 0),
      0,
    );
}
