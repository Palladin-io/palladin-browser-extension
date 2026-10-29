import { buildVaultScriptPackage } from './script-package'
import {
  buildCanonicalGrantEnvelope,
  canonicalGrantPolicyFieldId,
  createCapturedCredentialSecret,
  currentVaultPlaintext,
  GRANT_DELIVERY_POLICY,
  listCanonicalGrantableFieldIds,
  openCurrentMemberSecret,
  openVaultDerivedEnvelope,
  openVaultProjection,
  projectCanonicalCredentialDiscovery,
  sealCanonicalCredentialEntry,
  wipe,
} from '@palladin/crypto'
type MemberSecretV1 = currentVaultPlaintext.MemberSecretV1
import { matchesTab } from '@shared/security/domain'
import { readSignInBinding, withSignInBinding, type SignInBinding, type SignInBindingState } from '@shared/signin/binding'
import type { SubmittedCredential } from '@shared/messaging/credential-capture'
import type { CredentialCaptureChoices, CredentialWriteTarget } from '../../capture/credential-coordinator'
import { ENTRY_TYPE_CREDENTIAL } from '../entry-metadata'
import { VaultDataError } from '../errors'
import { VaultClientError } from '../transport'
import { Protocol2MutationConflictError, type Protocol2VaultClient, type UpdateCanonicalEntryRequest } from './client'
import type { EncryptedVaultSummary } from './contracts'
import type { EntryGrantContext } from './grant-context'
import type { Protocol2SessionAccessor, Protocol2VaultDataService } from './service'

type EntryDetail = Awaited<ReturnType<Protocol2VaultClient['getEntry']>>

export interface SignInTargets {
  readonly writable: boolean
  readonly vaults: { readonly vaultId: string; readonly label: string; readonly isDefault: boolean }[]
  readonly credentials: {
    readonly vaultId: string
    readonly entryId: string
    readonly revision: string
    readonly label: string
    readonly username: string
    readonly vaultLabel: string
    readonly signIn: SignInBindingState
  }[]
}

export type SignInWriteTarget =
  | { readonly action: 'update'; readonly vaultId: string; readonly entryId: string; readonly revision: string }
  | { readonly action: 'create'; readonly vaultId: string }

export interface CredentialWriterDeps {
  readonly client: Protocol2VaultClient
  readonly session: Protocol2SessionAccessor
  readonly data: Pick<Protocol2VaultDataService, 'refresh' | 'getMetadata'>
  canWrite(): Promise<boolean>
}

export class Protocol2CredentialWriter {
  constructor(private readonly deps: CredentialWriterDeps) {}

  async choices(credential: SubmittedCredential, url: string): Promise<CredentialCaptureChoices> {
    this.secureUrl(url)
    if (!(await this.deps.canWrite())) return { identical: false, targets: [], defaultIndex: null }
    const { privateKey, userId } = await this.context()
    const metadata = await this.deps.data.refresh()
    const vaults = await this.withAuth((token) => this.deps.client.listVaults(token))
    const targets: CredentialWriteTarget[] = []
    // A login explicitly filled from a related site need not be saved again.
    // Related-host comparison only suppresses an identical pair; it never
    // authorizes a write, adds an update target, or changes autofill policy.
    const comparisonScope = credential.kind === 'login' ? 'related-login-comparison' : 'exact-host'
    let personalIndex: number | null = null
    for (const listed of vaults) {
      const vault = await this.withAuth((token) => this.deps.client.getVault(token, listed.id))
      const opened = await openVaultProjection(vault, privateKey, userId)
      try {
        if (vault.isDefault) personalIndex = targets.length
        targets.push({ action: 'create', vaultId: vault.id, label: opened.metadata.name, vaultLabel: opened.metadata.name })
        for (const entry of metadata.filter((candidate) => candidate.vaultId === vault.id
          && candidate.type === ENTRY_TYPE_CREDENTIAL && matchesTab(url, candidate.urlDomain,
            { exactSubdomain: comparisonScope === 'exact-host' }))) {
          const detail = await this.withAuth((token) => this.deps.client.getEntry(token, vault.id, entry.id))
          const secret = await this.openCredential(detail, vault, entry.id, opened.vaultKey, url, comparisonScope)
          const exactAccount = credential.username.length > 0 && secret.content.username === credential.username
          if (exactAccount && secret.content.password === credential.password) {
            return { identical: true, targets: [], defaultIndex: null }
          }
          if (!matchesTab(url, entry.urlDomain) || !matchesTab(url, secret.content.urlDomain)) continue
          targets.push({ action: 'update', vaultId: vault.id, entryId: entry.id,
            revision: detail.currentRevision, label: secret.content.username
              ? `${secret.memberLabel} (${secret.content.username})` : secret.memberLabel,
            vaultLabel: opened.metadata.name,
            exactAccount, previousPasswordMatches: credential.previousPassword !== null
              && secret.content.password === credential.previousPassword })
        }
      } finally { wipe(opened.vaultKey) }
    }
    const exact = targets.map((target, index) => ({ target, index }))
      .filter(({ target }) => target.action === 'update' && target.exactAccount)
    return { identical: false, targets,
      defaultIndex: credential.kind !== 'registration' && exact.length === 1 ? exact[0]!.index : personalIndex }
  }

  async save(
    credential: SubmittedCredential,
    url: string,
    target: CredentialWriteTarget,
    stillAuthorized: () => Promise<boolean>,
  ): Promise<{ action: 'created' | 'updated'; revision: string }> {
    const site = this.secureUrl(url)
    const { privateKey, userId } = await this.context()
    if (!(await this.deps.canWrite()) || !(await stillAuthorized())) throw new VaultDataError('locked', 'Capture authorization changed')
    const vault = await this.withAuth((token) => this.deps.client.getVault(token, target.vaultId))
    const opened = await openVaultProjection(vault, privateKey, userId)
    let discoveryKey: Uint8Array | undefined
    const authorized = async () => this.deps.session.getPrivateKey() === privateKey
      && await this.deps.session.getUserId() === userId && await stillAuthorized()
    try {
      discoveryKey = await openVaultDerivedEnvelope(vault.discoveryKey, opened.vaultKey)
      if (target.action === 'create') {
        const entryId = await this.withAuth((token) => this.deps.client.issueEntryCreationChallenge(token, vault.id))
        const icon = await this.withAuth(token => this.deps.client.resolveWebsiteIcon(token, site.hostname))
        const secret = { ...createCapturedCredentialSecret({ label: site.hostname, username: credential.username,
          password: credential.password, url: site.origin, urlDomain: site.hostname }), icon: icon ?? null }
        const material = await sealCanonicalCredentialEntry({ organizationId: vault.organizationId, vaultId: vault.id,
          entryId, revision: '1', vaultKeyVersion: vault.currentKeyEpoch.vaultKeyVersion,
          vdkVersion: vault.currentKeyEpoch.vdkVersion, memberKeyGeneration: vault.memberKeyGeneration,
        }, secret, opened.vaultKey, discoveryKey, 1)
        const created = await this.withAuth(async (token) => {
          if (!(await authorized())) throw new VaultDataError('locked', 'Capture authorization changed')
          return this.deps.client.createEntry(token, { vaultId: vault.id, entryId, ...material, deliveryPolicy: 'standard' })
        })
        void this.refreshAfterWrite()
        return { action: 'created', revision: created.currentRevision }
      }
      const detail = await this.withAuth((token) => this.deps.client.getEntry(token, vault.id, target.entryId))
      if (detail.currentRevision !== target.revision) throw new Protocol2MutationConflictError()
      const previous = await this.openCredential(detail, vault, target.entryId, opened.vaultKey, url)
      if (target.exactAccount && previous.content.username !== credential.username) throw new Protocol2MutationConflictError()
      const next = { ...previous, content: { ...previous.content, password: credential.password } }
      const saved = await this.commitUpdate(vault, detail, previous, next, opened.vaultKey, discoveryKey, authorized)
      void this.refreshAfterWrite()
      return { action: 'updated', revision: saved.currentRevision }
    } finally {
      wipe(opened.vaultKey)
      if (discoveryKey) wipe(discoveryKey)
    }
  }

  /** Exact-host Credentials, their decrypted sign-in state and writable Vaults for one HTTPS page. */
  async signInTargets(url: string): Promise<SignInTargets> {
    this.secureUrl(url)
    const writable = await this.deps.canWrite()
    const { privateKey, userId } = await this.context()
    const metadata = await this.deps.data.getMetadata()
    const vaults = await this.withAuth((token) => this.deps.client.listVaults(token))
    const result: SignInTargets = { writable, vaults: [], credentials: [] }
    for (const listed of vaults) {
      const vault = await this.withAuth((token) => this.deps.client.getVault(token, listed.id))
      const opened = await openVaultProjection(vault, privateKey, userId)
      try {
        if (writable) result.vaults.push({ vaultId: vault.id, label: opened.metadata.name, isDefault: vault.isDefault === true })
        for (const entry of metadata.filter((candidate) => candidate.vaultId === vault.id
          && candidate.type === ENTRY_TYPE_CREDENTIAL && matchesTab(url, candidate.urlDomain))) {
          let detail: EntryDetail
          let secret: MemberSecretV1
          try {
            detail = await this.withAuth((token) => this.deps.client.getEntry(token, vault.id, entry.id))
            secret = await this.openCredential(detail, vault, entry.id, opened.vaultKey, url)
          } catch { continue /* One inconsistent Entry must not hide the others. */ }
          if (secret.entryType !== 'credential') continue
          result.credentials.push({ vaultId: vault.id, entryId: entry.id, revision: detail.currentRevision,
            label: secret.memberLabel, username: secret.content.username, vaultLabel: opened.metadata.name,
            signIn: readSignInBinding(secret) })
        }
      } finally { wipe(opened.vaultKey) }
    }
    return result
  }

  /**
   * Writes one explicitly confirmed sign-in method. Update keeps every other
   * field; create makes a password-less Credential (empty username) that
   * automatic exact-host fill never selects.
   */
  async saveSignIn(
    url: string,
    target: SignInWriteTarget,
    binding: SignInBinding,
    label: string,
    stillAuthorized: () => Promise<boolean>,
  ): Promise<{ action: 'created' | 'updated'; revision: string }> {
    const site = this.secureUrl(url)
    if (target.action === 'update') {
      const revision = await this.mutateCredential(target.vaultId, target.entryId, target.revision, url,
        (secret) => withSignInBinding(secret, binding, label), stillAuthorized)
      return { action: 'updated', revision }
    }
    const { privateKey, userId } = await this.context()
    if (!(await this.deps.canWrite()) || !(await stillAuthorized())) throw new VaultDataError('locked', 'Sign-in authorization changed')
    const vault = await this.withAuth((token) => this.deps.client.getVault(token, target.vaultId))
    const opened = await openVaultProjection(vault, privateKey, userId)
    let discoveryKey: Uint8Array | undefined
    try {
      discoveryKey = await openVaultDerivedEnvelope(vault.discoveryKey, opened.vaultKey)
      const entryId = await this.withAuth((token) => this.deps.client.issueEntryCreationChallenge(token, vault.id))
      const icon = await this.withAuth(token => this.deps.client.resolveWebsiteIcon(token, site.hostname))
      const secret = withSignInBinding({ ...createCapturedCredentialSecret({ label: site.hostname, username: '',
        password: '', url: site.origin, urlDomain: site.hostname }), icon: icon ?? null }, binding, label)
      if (secret.entryType !== 'credential') throw new Error('Sign-in methods require a Credential')
      const material = await sealCanonicalCredentialEntry({ organizationId: vault.organizationId, vaultId: vault.id,
        entryId, revision: '1', vaultKeyVersion: vault.currentKeyEpoch.vaultKeyVersion,
        vdkVersion: vault.currentKeyEpoch.vdkVersion, memberKeyGeneration: vault.memberKeyGeneration,
      }, secret, opened.vaultKey, discoveryKey, 1)
      const created = await this.withAuth(async (token) => {
        if (this.deps.session.getPrivateKey() !== privateKey || await this.deps.session.getUserId() !== userId
          || !(await stillAuthorized())) throw new VaultDataError('locked', 'Sign-in authorization changed')
        return this.deps.client.createEntry(token, { vaultId: vault.id, entryId, ...material, deliveryPolicy: 'standard' })
      })
      void this.refreshAfterWrite()
      return { action: 'created', revision: created.currentRevision }
    } finally {
      wipe(opened.vaultKey)
      if (discoveryKey) wipe(discoveryKey)
    }
  }

  /** Popup edit/remove of the sign-in method on one Credential the member already opened. */
  async setEntrySignIn(
    vaultId: string, entryId: string, binding: SignInBinding | null, label: string,
    stillAuthorized: () => Promise<boolean>,
  ): Promise<{ revision: string }> {
    return { revision: await this.mutateCredential(vaultId, entryId, null, null,
      (secret) => withSignInBinding(secret, binding, label), stillAuthorized) }
  }

  private async mutateCredential(
    vaultId: string, entryId: string, expectedRevision: string | null, url: string | null,
    mutate: (secret: MemberSecretV1) => MemberSecretV1, stillAuthorized: () => Promise<boolean>,
  ): Promise<string> {
    const { privateKey, userId } = await this.context()
    if (!(await this.deps.canWrite()) || !(await stillAuthorized())) throw new VaultDataError('locked', 'Sign-in authorization changed')
    const vault = await this.withAuth((token) => this.deps.client.getVault(token, vaultId))
    const opened = await openVaultProjection(vault, privateKey, userId)
    let discoveryKey: Uint8Array | undefined
    const authorized = async () => this.deps.session.getPrivateKey() === privateKey
      && await this.deps.session.getUserId() === userId && await stillAuthorized()
    try {
      discoveryKey = await openVaultDerivedEnvelope(vault.discoveryKey, opened.vaultKey)
      const detail = await this.withAuth((token) => this.deps.client.getEntry(token, vault.id, entryId))
      if (expectedRevision !== null && detail.currentRevision !== expectedRevision) throw new Protocol2MutationConflictError()
      assertCoordinates(detail, vault, entryId)
      const previous = await openCurrentMemberSecret(detail.entryKey, detail.memberSecret, opened.vaultKey,
        { organizationId: vault.organizationId, vaultId: vault.id, entryId, revision: detail.currentRevision })
      if (previous.entryType !== 'credential' || (url !== null && !matchesTab(url, previous.content.urlDomain))) {
        throw new Error('Sign-in Entry scope changed')
      }
      const saved = await this.commitUpdate(vault, detail, previous, mutate(previous), opened.vaultKey, discoveryKey, authorized)
      void this.refreshAfterWrite()
      return saved.currentRevision
    } finally {
      wipe(opened.vaultKey)
      if (discoveryKey) wipe(discoveryKey)
    }
  }

  private async commitUpdate(
    vault: EncryptedVaultSummary, detail: EntryDetail, previous: MemberSecretV1, next: MemberSecretV1,
    vaultKey: Uint8Array, discoveryKey: Uint8Array, authorized: () => Promise<boolean>,
  ) {
    if (next.entryType !== 'credential') throw new Error('Credential update changed the Entry type')
    const revision = (BigInt(detail.currentRevision) + 1n).toString()
    const material = await sealCanonicalCredentialEntry({ organizationId: vault.organizationId, vaultId: vault.id,
      entryId: detail.id, revision, entryKeyRevision: '1', entryKeyVersion: detail.currentKeyVersion + 1,
      memberIndexRevision: (BigInt(detail.memberIndexRevision) + 1n).toString(),
      agentDiscoveryRevision: (BigInt(detail.agentDiscoveryRevisionHighWatermark) + 1n).toString(),
      vaultKeyVersion: vault.currentKeyEpoch.vaultKeyVersion, vdkVersion: vault.currentKeyEpoch.vdkVersion,
      memberKeyGeneration: vault.memberKeyGeneration,
    }, next, vaultKey, discoveryKey, 2)
    const grants = await this.withAuth((token) => this.deps.client.getActiveGrants(token, vault.id))
    const grantMaterial = await this.grants(grants, vault, detail, next, revision, vaultKey)
    const discoveryChanged = previous.entryType !== 'credential'
      || JSON.stringify(projectCanonicalCredentialDiscovery(previous)) !== JSON.stringify(projectCanonicalCredentialDiscovery(next))
    return this.withAuth(async (token) => {
      if (!(await authorized())) throw new VaultDataError('locked', 'Credential authorization changed')
      return this.deps.client.updateEntry(token, { vaultId: vault.id, entryId: detail.id,
        baseRevision: detail.currentRevision, newEntryKey: material.entryKey,
        memberSecret: material.memberSecret, memberIndex: material.memberIndex,
        agentDiscoveryChanged: discoveryChanged, agentDiscovery: discoveryChanged ? material.agentDiscovery : null,
        deliveryPolicy: detail.deliveryPolicy, ...grantMaterial })
    })
  }

  private async grants(
    grants: readonly EntryGrantContext[], vault: EncryptedVaultSummary,
    detail: EntryDetail, secret: MemberSecretV1, revision: string, vaultKey: Uint8Array,
  ): Promise<Pick<UpdateCanonicalEntryRequest, 'grantEnvelopes' | 'scriptGrantPackages'>> {
    const grantEnvelopes: Awaited<ReturnType<typeof buildCanonicalGrantEnvelope>>[] = []
    const scriptGrantPackages: Awaited<ReturnType<typeof buildVaultScriptPackage>>[] = []
    const grantable = new Set(listCanonicalGrantableFieldIds(secret))
    for (const grant of grants) {
      if (grant.vaultId !== vault.id) throw new Error('Grant Vault scope mismatch')
      if (grant.type === 'granular' && grant.entryId === detail.id) {
        const scope = grant.entryScopes.find((scope) => scope.entryId === detail.id)
        if (!scope?.grantEnvelopeRevision || !scope.grantKeyVersion || !scope.fieldIds.length
          || !grant.agentId || !grant.agentPublicKey || !grant.recipientAgentKeyVersion) throw new Error('Incomplete grant context')
        const approvedFieldIds = (scope.fieldSelectionMode === 'all'
          ? [...grantable] : scope.fieldSelectionMode === 'selected'
            ? scope.selectedFieldIds ?? scope.fieldIds : scope.fieldIds)
          .map((id) => canonicalGrantPolicyFieldId(secret.entryType, id)).filter((id) => grantable.has(id))
        if (approvedFieldIds.length === 0) throw new Error('Grant field policy changed')
        grantEnvelopes.push(await buildCanonicalGrantEnvelope({
          secret, organizationId: vault.organizationId, vaultId: vault.id, entryId: detail.id,
          grantId: grant.id, agentId: grant.agentId, agentPublicKey: grant.agentPublicKey,
          entryRevision: revision, grantEnvelopeRevision: (BigInt(scope.grantEnvelopeRevision) + 1n).toString(),
          grantKeyVersion: scope.grantKeyVersion + 1, recipientKeyVersion: grant.recipientAgentKeyVersion,
          memberKeyGeneration: vault.memberKeyGeneration, approvedFieldIds,
          approvedMethods: methodsMask(grant.methods), deliveryPolicy: GRANT_DELIVERY_POLICY[detail.deliveryPolicy],
          ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
          ...(grant.queryLimit !== null ? { remainingUses: grant.queryLimit - (grant.queryCount ?? 0) } : {}),
        }))
      }
      if (grant.type === 'scriptExecution' && grant.scriptScopes.some((scope) => scope.entryId === detail.id)) {
        scriptGrantPackages.push(await this.scriptPackage(grant, vault, detail, secret, revision, vaultKey))
      }
    }
    return { grantEnvelopes, scriptGrantPackages }
  }

  private async scriptPackage(
    grant: EntryGrantContext, vault: EncryptedVaultSummary,
    updated: EntryDetail, next: MemberSecretV1, revision: string, vaultKey: Uint8Array,
  ) {
    const parent = grant.scriptScopes.find((scope) => scope.isScript)
    if (!parent || !grant.agentId || !grant.agentAccessEpoch || !grant.agentPublicKey || !grant.recipientAgentKeyVersion
      || !grant.scriptPackageRevision) throw new Error('Incomplete Script grant context')
    const open = async (entryId: string) => {
      if (entryId === updated.id) return { secret: next, revision }
      const detail = await this.withAuth((token) => this.deps.client.getEntry(token, vault.id, entryId))
      assertCoordinates(detail, vault, entryId)
      const secret = await openCurrentMemberSecret(detail.entryKey, detail.memberSecret, vaultKey,
        { organizationId: vault.organizationId, vaultId: vault.id, entryId, revision: detail.currentRevision })
      return { secret, revision: detail.currentRevision }
    }
    const script = await open(parent.entryId)
    return buildVaultScriptPackage({ vault, vaultKey, scriptEntryId: parent.entryId, scriptRevision: script.revision,
      secret: script.secret, agentId: grant.agentId, agentAccessEpoch: grant.agentAccessEpoch,
      agentPublicKey: grant.agentPublicKey, recipientKeyVersion: grant.recipientAgentKeyVersion,
      grantId: grant.id, packageRevision: (BigInt(grant.scriptPackageRevision) + 1n).toString(), open })
  }

  private async openCredential(detail: EntryDetail, vault: EncryptedVaultSummary, entryId: string, key: Uint8Array,
    url: string, scope: 'exact-host' | 'related-login-comparison' = 'exact-host') {
    assertCoordinates(detail, vault, entryId)
    const secret = await openCurrentMemberSecret(detail.entryKey, detail.memberSecret, key,
      { organizationId: vault.organizationId, vaultId: vault.id, entryId, revision: detail.currentRevision })
    if (secret.entryType !== 'credential' || !matchesTab(url, secret.content.urlDomain,
      { exactSubdomain: scope === 'exact-host' })) throw new Error('Capture Entry scope changed')
    return secret
  }

  private secureUrl(url: string): URL {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') throw new Error('Capture requires HTTPS')
    return parsed
  }

  private async context() {
    const privateKey = this.deps.session.getPrivateKey()
    const userId = await this.deps.session.getUserId()
    if (!privateKey || !userId) throw new VaultDataError('locked', 'Capture requires an unlocked session')
    return { privateKey, userId }
  }

  private async withAuth<T>(operation: (token: string) => Promise<T>): Promise<T> {
    const token = await this.deps.session.getAccessToken()
    if (!token) throw new VaultDataError('not-authenticated', 'Capture requires authentication')
    try { return await operation(token) }
    catch (error) {
      if (!(error instanceof VaultClientError) || error.code !== 'unauthorized') throw error
      const refreshed = await this.deps.session.refreshAccessToken()
      if (!refreshed) throw error
      return operation(refreshed)
    }
  }

  private async refreshAfterWrite(): Promise<void> {
    // The mutation response is authoritative. Cache repair must not delay its
    // acknowledgement, opt-in persistence, or wiping this write's owned keys.
    try { await this.deps.data.refresh() } catch { /* A committed write must not be offered a second time. */ }
  }
}

function assertCoordinates(detail: EntryDetail, vault: EncryptedVaultSummary, entryId: string): void {
  if (detail.organizationId !== vault.organizationId || detail.vaultId !== vault.id || detail.id !== entryId
    || (detail.state !== 'active' && detail.state !== 1)) throw new Error('Capture Entry scope changed')
}

function methodsMask(methods: string | null): number {
  const bits: Record<string, number> = { get: 1, exec: 2, inject: 4 }
  const names = methods?.toLowerCase().split(',').map((name) => name.trim()) ?? []
  if (!names.length || names.some((name) => bits[name] === undefined)) throw new Error('Unsupported grant methods')
  return names.reduce((mask, name) => mask | bits[name]!, 0)
}
