import {
  buildCanonicalScriptExecutionManifest,
  currentVaultPlaintext,
  fromBase64,
  openVaultDerivedEnvelope,
  sealCanonicalScriptExecutionPackage,
  wipe,
  type ScriptExecutionPackageReferenceInput,
} from '@palladin/crypto';
import type { EncryptedVaultSummary } from './contracts';

export async function buildVaultScriptPackage(input: {
  vault: EncryptedVaultSummary;
  vaultKey: Uint8Array;
  scriptEntryId: string;
  scriptRevision: string;
  secret: currentVaultPlaintext.MemberSecretV1;
  agentId: string;
  agentAccessEpoch: number;
  agentPublicKey: string;
  recipientKeyVersion: number;
  grantId: string;
  packageRevision: string;
  open(
    entryId: string,
  ): Promise<{
    secret: currentVaultPlaintext.MemberSecretV1;
    revision: string;
  }>;
}) {
  const { vault, secret } = input;
  const signing = vault.vaultPrivateKeys.find(
    (envelope) => envelope.descriptor.purpose === 4,
  );
  if (
    secret.entryType !== 'script' ||
    !signing ||
    signing.descriptor.keyVersion !==
      vault.currentKeyEpoch.manifestSigningKeyVersion ||
    signing.descriptor.scope.organizationId !== vault.organizationId ||
    signing.descriptor.scope.vaultId !== vault.id
  )
    throw new Error('Unavailable script signing material');
  const entries: ScriptExecutionPackageReferenceInput[] = [];
  const recipient = fromBase64(input.agentPublicKey);
  let signingKey: Uint8Array | undefined;
  try {
    signingKey = await openVaultDerivedEnvelope(signing, input.vaultKey);
    const referenceRevisions: Record<string, string> = {};
    for (const entryId of new Set(
      secret.content.refs.map((ref) => ref.entryId),
    )) {
      const entry = await input.open(entryId);
      referenceRevisions[entryId] = entry.revision;
      entries.push({
        entryId,
        entryRevision: entry.revision,
        encodedMemberSecret: currentVaultPlaintext.encodeMemberSecret(
          entry.secret,
        ),
      });
    }
    const manifest = buildCanonicalScriptExecutionManifest({
      organizationId: vault.organizationId,
      vaultId: vault.id,
      agentId: input.agentId,
      agentAccessEpoch: input.agentAccessEpoch,
      scriptEntryId: input.scriptEntryId,
      scriptRevision: input.scriptRevision,
      memberSecret: secret,
      referenceRevisions,
    });
    return await sealCanonicalScriptExecutionPackage({
      manifest,
      grantId: input.grantId,
      packageRevision: input.packageRevision,
      recipientAgentKeyVersion: input.recipientKeyVersion,
      recipientAgentPublicKey: recipient,
      vaultSigningKeyVersion: vault.currentKeyEpoch.manifestSigningKeyVersion,
      vaultSigningPrivateKey: signingKey,
      entries,
    });
  } finally {
    wipe(recipient);
    if (signingKey) wipe(signingKey);
    for (const entry of entries) wipe(entry.encodedMemberSecret);
  }
}
