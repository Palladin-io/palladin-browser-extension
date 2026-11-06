import type { CardReviewEntry, SecretCardTarget } from '../../capture/secret-coordinator'
import type { ManualEntrySaveInput } from './service'
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
  sealCurrentCanonicalEntry,
  wipe,
  type CredentialMemberSecret,
} from '@palladin/crypto'
type MemberSecretV1 = currentVaultPlaintext.MemberSecretV1
import { isManualCustomFields } from '../commands'
import type { TotpEntryRef } from '@shared/messaging/totp-capture'
import { matchesTab } from '@shared/security/domain'
import { readSignInMethods, mutateSignInMethod, sameSignInAccount, withSignInBinding, type SignInBinding, type SignInBindingState } from '@shared/signin/binding'
import type { SubmittedCredential } from '@shared/messaging/credential-capture'
import type { CredentialCaptureChoices, CredentialWriteTarget } from '../../capture/credential-coordinator'
import { ENTRY_TYPE_CREDENTIAL } from '../entry-metadata'
import { VaultDataError } from '../errors'
import { VaultClientError } from '../transport'
import { Protocol2MutationConflictError, type Protocol2VaultClient, type UpdateCanonicalEntryRequest } from './client'
import type { EncryptedVaultSummary } from './contracts'
import type { EntryGrantContext } from './grant-context'
import type { VaultKeyEpochFloor } from './key-epoch-floor'
import type { Protocol2SessionAccessor, Protocol2VaultDataService } from './service'

type EntryDetail = Awaited<ReturnType<Protocol2VaultClient['getEntry']>>

export type CapturedTotp = NonNullable<CredentialMemberSecret['content']['totp']>
export type TotpWriteTarget =
  | { readonly action: 'create'; readonly vaultId: string; readonly label: string; readonly vaultLabel: string }
  | { readonly action: 'update'; readonly vaultId: string; readonly entryId: string; readonly revision: string;
      readonly label: string; readonly vaultLabel: string; readonly hasTotp: boolean; readonly domainMismatch?: boolean }
export interface SignInTargets {
  readonly writable: boolean
  readonly vaults: { readonly vaultId: string; readonly label: string; readonly isDefault: boolean }[]
  readonly credentials: {
    readonly vaultId: string
    readonly entryId: string
    readonly revision: string
    readonly label: string
    readonly username: string
    readonly icon?: string
    readonly color?: string
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
  readonly keyEpochFloor: VaultKeyEpochFloor
  canWrite(): Promise<boolean>
}

export class Protocol2CredentialWriter {
  constructor(private readonly deps: CredentialWriterDeps) {}

  async captureIcon(url: string): Promise<string | undefined> {
    const site = this.secureUrl(url);
    const icon = await this.withAuth(token => this.deps.client.resolveWebsiteIcon(token, site.hostname));
    return icon ? `public-asset:${icon.assetId}` : undefined;
  }

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
      const opened = await this.deps.keyEpochFloor.observe(userId, vault,
        () => openVaultProjection(vault, privateKey, userId))
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
            review: { entryType: 'credential', label: secret.memberLabel, username: secret.content.username,
              password: credential.password, url: secret.content.url ?? new URL(url).origin,
              notes: secret.content.notes ?? '', customFields: secret.content.customFields.flatMap(field => { const fields = [field]; return isManualCustomFields(fields) ? fields : [] }),
              ...(secret.icon ? { icon: secret.icon.kind === 'glyph' ? secret.icon.value : `public-asset:${secret.icon.assetId}` } : {}), ...(secret.color ? { color: secret.color } : {}) },
            exactAccount, previousPasswordMatches: credential.previousPassword !== null
              && secret.content.password === credential.previousPassword })
        }
      } finally { wipe(opened.vaultKey) }
    }
    const updates = targets.filter(target => target.action === 'update')
    if (updates.length > 0) return { identical: false, targets: updates, defaultIndex: updates.length === 1 ? 0 : null }
    return { identical: false, targets, defaultIndex: personalIndex }
  }

  async totpChoices(url: string, selected?: TotpEntryRef): Promise<TotpWriteTarget[]> {
    this.secureUrl(url)
    if (!(await this.deps.canWrite())) return []
    const { privateKey, userId } = await this.context()
    const metadata = await this.deps.data.refresh()
    const vaults = await this.withAuth(token => this.deps.client.listVaults(token))
    const targets: TotpWriteTarget[] = []
    for (const listed of vaults.filter(vault => !selected || vault.id === selected.vaultId)) {
      const vault = await this.withAuth(token => this.deps.client.getVault(token, listed.id))
      const opened = await this.deps.keyEpochFloor.observe(userId, vault, () => openVaultProjection(vault, privateKey, userId))
      try {
        if (!selected) targets.push({ action: 'create', vaultId: vault.id, label: opened.metadata.name, vaultLabel: opened.metadata.name })
        for (const entry of metadata.filter(item => item.vaultId === vault.id && item.type === ENTRY_TYPE_CREDENTIAL
          && (selected ? item.id === selected.id : matchesTab(url, item.urlDomain, { exactSubdomain: true })))) {
          const detail = await this.withAuth(token => this.deps.client.getEntry(token, vault.id, entry.id))
          const secret = await this.openCredential(detail, vault, entry.id, opened.vaultKey, url, selected ? 'manual-totp' : 'exact-host')
          targets.push({ action: 'update', vaultId: vault.id, entryId: entry.id, revision: detail.currentRevision,
            label: secret.content.username ? `${secret.memberLabel} (${secret.content.username})` : secret.memberLabel,
            vaultLabel: opened.metadata.name, hasTotp: secret.content.totp !== null, domainMismatch: !matchesTab(url, secret.content.urlDomain, { exactSubdomain: true }) })
        }
      } finally { wipe(opened.vaultKey) }
    }
    return targets
  }

  async save(
    credential: SubmittedCredential,
    url: string,
    target: CredentialWriteTarget,
    stillAuthorized: () => Promise<boolean>,
    review?: Extract<ManualEntrySaveInput, { entryType: 'credential' }>,
  ): Promise<{ action: 'created' | 'updated'; revision: string; vaultId?: string; entryId?: string }> {
    if (review && (!review.url || new URL(review.url).origin !== new URL(url).origin)) throw new Error('Capture URL scope changed')
    const selectedIcon = review?.icon?.startsWith('public-asset:')
      ? await this.withAuth(token => this.deps.client.getCatalogIcon(token, review.icon!.slice(13)))
      : review?.icon ? { kind: 'glyph' as const, value: review.icon } : undefined
    const edit = (previous: CredentialMemberSecret): CredentialMemberSecret => {
      if (!review) return { ...previous, content: { ...previous.content, password: credential.password } }
      const customFields = [...previous.content.customFields.filter(field => !isManualCustomFields([field])), ...(review.customFields ?? [])]
      return { ...previous, memberLabel: review.label,
        ...(selectedIcon !== undefined ? { icon: selectedIcon } : {}), ...(review.color !== undefined ? { color: review.color } : {}),
        agentFieldAccess: { ...Object.fromEntries(Object.entries(previous.agentFieldAccess).filter(([key]) => !key.startsWith('custom:'))),
          ...Object.fromEntries(customFields.map(field => [field.id, previous.agentFieldAccess[field.id] ?? 'never'])) },
        content: { ...previous.content, username: review.username, password: review.password, url: review.url!,
          urlDomain: new URL(review.url!).hostname, notes: review.notes || null, customFields } }
    }
    return this.write(url, target, stillAuthorized,
      site => edit(createCapturedCredentialSecret({ label: site.hostname, username: credential.username,
        password: credential.password, url: site.origin, urlDomain: site.hostname })),
      previous => {
        if (target.action === 'update' && target.exactAccount && previous.content.username !== (target.review?.username ?? credential.username)) throw new Protocol2MutationConflictError()
        return edit(previous)
      })
  }

  async saveTotp(totp: CapturedTotp, url: string, target: TotpWriteTarget,
    stillAuthorized: () => Promise<boolean>, create?: { label: string; username: string }, confirmDomainMismatch = false): Promise<{ action: 'created' | 'updated'; revision: string; vaultId?: string; entryId?: string }> {
    return this.write(url, target, stillAuthorized,
      site => {
        const secret = createCapturedCredentialSecret({ label: create?.label ?? site.hostname, username: create?.username ?? '',
          password: '', url: site.origin, urlDomain: site.hostname })
        return { ...secret, content: { ...secret.content, totp } }
      },
      previous => {
        const current = previous.content.totp
        if (current && current.secret === totp.secret && current.algorithm === totp.algorithm && current.digits === totp.digits
          && current.period === totp.period && current.issuer === totp.issuer && current.account === totp.account) return previous
        return { ...previous, content: { ...previous.content, totp } }
      }, target.action === 'update' && target.domainMismatch && confirmDomainMismatch ? 'manual-totp' : 'exact-host')
  }

  private async write(url: string, target: CredentialWriteTarget | TotpWriteTarget,
    stillAuthorized: () => Promise<boolean>, create: (site: URL) => CredentialMemberSecret,
    update: (previous: CredentialMemberSecret) => CredentialMemberSecret, scope: 'exact-host' | 'manual-totp' = 'exact-host'): Promise<{ action: 'created' | 'updated'; revision: string; vaultId?: string; entryId?: string }> {
    const site = this.secureUrl(url)
    const { privateKey, userId } = await this.context()
    if (!(await this.deps.canWrite()) || !(await stillAuthorized())) throw new VaultDataError('locked', 'Capture authorization changed')
    const vault = await this.withAuth((token) => this.deps.client.getVault(token, target.vaultId))
    const opened = await this.deps.keyEpochFloor.openForWrite(userId, vault,
      () => openVaultProjection(vault, privateKey, userId))
    let discoveryKey: Uint8Array | undefined
    const assertEpoch = () => this.deps.keyEpochFloor.assertCurrent(userId, vault)
    const authorized = async () => this.deps.session.getPrivateKey() === privateKey
      && await this.deps.session.getUserId() === userId && await stillAuthorized()
    try {
      discoveryKey = await openVaultDerivedEnvelope(vault.discoveryKey, opened.vaultKey)
      if (target.action === 'create') {
        const entryId = await this.withAuth((token) => this.deps.client.issueEntryCreationChallenge(token, vault.id))
        const icon = await this.withAuth(token => this.deps.client.resolveWebsiteIcon(token, site.hostname))
        const draft = create(site)
        const secret = { ...draft, icon: draft.icon ?? icon ?? null }
        assertEpoch()
        const material = await sealCanonicalCredentialEntry({ organizationId: vault.organizationId, vaultId: vault.id,
          entryId, revision: '1', vaultKeyVersion: vault.currentKeyEpoch.vaultKeyVersion,
          vdkVersion: vault.currentKeyEpoch.vdkVersion, memberKeyGeneration: vault.memberKeyGeneration,
        }, secret, opened.vaultKey, discoveryKey, 1)
        const created = await this.withAuth(async (token) => {
          if (!(await authorized())) throw new VaultDataError('locked', 'Capture authorization changed')
          assertEpoch()
          return this.deps.client.createEntry(token, { vaultId: vault.id, entryId, ...material, deliveryPolicy: 'standard' })
        })
        void this.refreshAfterWrite()
        return { action: 'created', revision: created.currentRevision, vaultId: vault.id, entryId }
      }
      const detail = await this.withAuth((token) => this.deps.client.getEntry(token, vault.id, target.entryId))
      if (detail.currentRevision !== target.revision) throw new Protocol2MutationConflictError()
      const previous = await this.openCredential(detail, vault, target.entryId, opened.vaultKey, url, scope)
      const next = update(previous)
      if (next === previous) {
        if (!(await authorized())) throw new VaultDataError('locked', 'Capture authorization changed')
        return { action: 'updated', revision: detail.currentRevision, vaultId: vault.id, entryId: target.entryId }
      }
      const saved = await this.commitUpdate(vault, detail, previous, next, opened.vaultKey, discoveryKey, authorized, assertEpoch)
      void this.refreshAfterWrite()
      return { action: 'updated', revision: saved.currentRevision, vaultId: vault.id, entryId: target.entryId }
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
      const opened = await this.deps.keyEpochFloor.observe(userId, vault,
        () => openVaultProjection(vault, privateKey, userId))
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
          for (const signIn of methodStates(secret)) result.credentials.push({ vaultId: vault.id, entryId: entry.id, revision: detail.currentRevision,
            label: secret.memberLabel, username: secret.content.username, vaultLabel: opened.metadata.name,
            signIn,
            ...(secret.icon ? { icon: secret.icon.kind === 'glyph' ? secret.icon.value : `public-asset:${secret.icon.assetId}` } : {}),
            ...(secret.color ? { color: secret.color } : {}) })
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
  ): Promise<{ action: 'created' | 'updated'; revision: string; vaultId?: string; entryId?: string }> {
    const site = this.secureUrl(url)
    if (target.action === 'update') {
      const revision = await this.mutateCredential(target.vaultId, target.entryId, target.revision, url,
        (secret) => withSignInBinding(secret, binding, label), stillAuthorized)
      return { action: 'updated', revision, vaultId: target.vaultId, entryId: target.entryId }
    }
    const { privateKey, userId } = await this.context()
    if (!(await this.deps.canWrite()) || !(await stillAuthorized())) throw new VaultDataError('locked', 'Sign-in authorization changed')
    const vault = await this.withAuth((token) => this.deps.client.getVault(token, target.vaultId))
    const opened = await this.deps.keyEpochFloor.openForWrite(userId, vault,
      () => openVaultProjection(vault, privateKey, userId))
    let discoveryKey: Uint8Array | undefined
    const assertEpoch = () => this.deps.keyEpochFloor.assertCurrent(userId, vault)
    try {
      discoveryKey = await openVaultDerivedEnvelope(vault.discoveryKey, opened.vaultKey)
      const entryId = await this.withAuth((token) => this.deps.client.issueEntryCreationChallenge(token, vault.id))
      const icon = await this.withAuth(token => this.deps.client.resolveWebsiteIcon(token, site.hostname))
      const secret = withSignInBinding({ ...createCapturedCredentialSecret({ label: site.hostname, username: '',
        password: '', url: site.origin, urlDomain: site.hostname }), icon: icon ?? null }, binding, label)
      if (secret.entryType !== 'credential') throw new Error('Sign-in methods require a Credential')
      assertEpoch()
      const material = await sealCanonicalCredentialEntry({ organizationId: vault.organizationId, vaultId: vault.id,
        entryId, revision: '1', vaultKeyVersion: vault.currentKeyEpoch.vaultKeyVersion,
        vdkVersion: vault.currentKeyEpoch.vdkVersion, memberKeyGeneration: vault.memberKeyGeneration,
      }, secret, opened.vaultKey, discoveryKey, 1)
      const created = await this.withAuth(async (token) => {
        if (this.deps.session.getPrivateKey() !== privateKey || await this.deps.session.getUserId() !== userId
          || !(await stillAuthorized())) throw new VaultDataError('locked', 'Sign-in authorization changed')
        assertEpoch()
        return this.deps.client.createEntry(token, { vaultId: vault.id, entryId, ...material, deliveryPolicy: 'standard' })
      })
      void this.refreshAfterWrite()
      return { action: 'created', revision: created.currentRevision, vaultId: vault.id, entryId }
    } finally {
      wipe(opened.vaultKey)
      if (discoveryKey) wipe(discoveryKey)
    }
  }

  /** Popup edit/remove of the sign-in method on one Credential the member already opened. */
  /**
   * Popup edit/remove. A typed edit cannot name an Agent-visible provider
   * Credential: the existing reference survives only an unchanged provider and account.
   */
  async setEntrySignIn(
    vaultId: string, entryId: string, edit: Omit<SignInBinding, 'entry'> | null, label: string,
    stillAuthorized: () => Promise<boolean>, fieldId: string | null = null, agentVisible?: boolean,
  ): Promise<{ revision: string }> {
    return { revision: await this.mutateCredential(vaultId, entryId, null, null, (secret) => {
      if (edit === null) {
        const next = mutateSignInMethod(secret, fieldId, null, label)
        if (next.entryType === 'credential' && next.content.password.length === 0 && readSignInMethods(next).length === 0) {
          throw new Error('A Credential requires a password or sign-in method')
        }
        return next
      }
      const previous = readSignInMethods(secret).find(method => method.id === fieldId)
      const entry = previous && previous.binding.provider === edit.provider
        && sameSignInAccount(previous.binding.account, edit.account) ? previous.binding.entry : null
      return mutateSignInMethod(secret, fieldId, { ...edit, entry }, label, agentVisible)
    }, stillAuthorized) }
  }

  private async mutateCredential(
    vaultId: string, entryId: string, expectedRevision: string | null, url: string | null,
    mutate: (secret: MemberSecretV1) => MemberSecretV1, stillAuthorized: () => Promise<boolean>,
  ): Promise<string> {
    const { privateKey, userId } = await this.context()
    if (!(await this.deps.canWrite()) || !(await stillAuthorized())) throw new VaultDataError('locked', 'Sign-in authorization changed')
    const vault = await this.withAuth((token) => this.deps.client.getVault(token, vaultId))
    const opened = await this.deps.keyEpochFloor.openForWrite(userId, vault,
      () => openVaultProjection(vault, privateKey, userId))
    let discoveryKey: Uint8Array | undefined
    const assertEpoch = () => this.deps.keyEpochFloor.assertCurrent(userId, vault)
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
      const saved = await this.commitUpdate(vault, detail, previous, mutate(previous), opened.vaultKey, discoveryKey, authorized, assertEpoch)
      void this.refreshAfterWrite()
      return saved.currentRevision
    } finally {
      wipe(opened.vaultKey)
      if (discoveryKey) wipe(discoveryKey)
    }
  }

  async cardChoices(cardNumber: string): Promise<SecretCardTarget[]> {
    const pan = normalizedPan(cardNumber)
    if (!(await this.deps.canWrite())) return []
    const { privateKey, userId } = await this.context()
    const metadata = await this.deps.data.refresh()
    const vaults = await this.withAuth(token => this.deps.client.listVaults(token))
    const targets: SecretCardTarget[] = []
    for (const listed of vaults) {
      const vault = await this.withAuth(token => this.deps.client.getVault(token, listed.id))
      const opened = await this.deps.keyEpochFloor.observe(userId, vault, () => openVaultProjection(vault, privateKey, userId))
      try {
        for (const entry of metadata.filter(item => item.vaultId === vault.id && item.type === 3)) {
          const detail = await this.withAuth(token => this.deps.client.getEntry(token, vault.id, entry.id))
          assertCoordinates(detail, vault, entry.id)
          const previous = await openCurrentMemberSecret(detail.entryKey, detail.memberSecret, opened.vaultKey,
            { organizationId: vault.organizationId, vaultId: vault.id, entryId: entry.id, revision: detail.currentRevision })
          if (previous.entryType !== 'creditCard' || previous.content.cardNumber.replace(/[ -]/g, '') !== pan) continue
          const content = previous.content
          targets.push({ id: entry.id, vaultId: vault.id, revision: detail.currentRevision, name: previous.memberLabel,
            vaultName: opened.metadata.name, entry: { entryType: 'creditCard', label: previous.memberLabel,
              cardNumber: content.cardNumber, cardholderName: content.cardholderName, expiryMonth: content.expiryMonth,
              expiryYear: content.expiryYear, ...(content.cvv !== undefined ? { cvv: content.cvv } : {}),
              billingAddress: content.billingAddress ?? '', notes: content.notes ?? '',
              customFields: content.customFields.filter(editableCardField),
              ...(previous.icon?.kind === 'glyph' ? { icon: previous.icon.value } : {}),
              ...(previous.color ? { color: previous.color } : {}) } })
        }
      } finally { wipe(opened.vaultKey) }
    }
    return targets
  }

  async updateCard(target: SecretCardTarget, input: CardReviewEntry, capturedPan: string,
    stillAuthorized: () => Promise<boolean>): Promise<{ status: 'saved' }> {
    const pan = normalizedPan(capturedPan)
    if (normalizedPan(input.cardNumber) !== pan) throw new Error('Captured card changed')
    const { privateKey, userId } = await this.context()
    const authorized = async () => this.deps.session.getPrivateKey() === privateKey
      && await this.deps.session.getUserId() === userId && await this.deps.canWrite() && await stillAuthorized()
    if (!(await authorized())) throw new VaultDataError('locked', 'Capture authorization changed')
    const vault = await this.withAuth(token => this.deps.client.getVault(token, target.vaultId))
    const opened = await this.deps.keyEpochFloor.openForWrite(userId, vault, () => openVaultProjection(vault, privateKey, userId))
    let discoveryKey: Uint8Array | undefined
    try {
      const detail = await this.withAuth(token => this.deps.client.getEntry(token, vault.id, target.id))
      assertCoordinates(detail, vault, target.id)
      if (detail.currentRevision !== target.revision) throw new Protocol2MutationConflictError()
      const previous = await openCurrentMemberSecret(detail.entryKey, detail.memberSecret, opened.vaultKey,
        { organizationId: vault.organizationId, vaultId: vault.id, entryId: target.id, revision: detail.currentRevision })
      if (previous.entryType !== 'creditCard' || normalizedPan(previous.content.cardNumber) !== pan) throw new Error('Captured card target changed')
      const fields = [...(input.customFields ?? []), ...previous.content.customFields.filter(field => !editableCardField(field))]
      const { cvv: _previousCvv, ...content } = previous.content
      const access = Object.fromEntries(Object.entries(previous.agentFieldAccess).filter(([id]) => id !== 'creditCard.cvv' && (!id.startsWith('custom:') || fields.some(field => field.id === id))))
      const next: MemberSecretV1 = { ...previous, memberLabel: input.label.trim(),
        ...(input.icon !== undefined && !input.icon.startsWith('public-asset:') ? { icon: { kind: 'glyph', value: input.icon } as const } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        agentFieldAccess: { ...access, ...(input.cvv ? { 'creditCard.cvv': 'never' as const } : {}), ...Object.fromEntries(fields.map(field => [field.id, previous.agentFieldAccess[field.id] ?? 'never'])) },
        content: { ...content, cardNumber: pan, cardholderName: input.cardholderName.trim(),
          expiryMonth: input.expiryMonth, expiryYear: input.expiryYear, ...(input.cvv ? { cvv: input.cvv } : {}),
          billingAddress: input.billingAddress || null, notes: input.notes || null, customFields: fields } }
      discoveryKey = await openVaultDerivedEnvelope(vault.discoveryKey, opened.vaultKey)
      await this.commitUpdate(vault, detail, previous, next, opened.vaultKey, discoveryKey, authorized,
        () => this.deps.keyEpochFloor.assertCurrent(userId, vault))
      void this.refreshAfterWrite()
      return { status: 'saved' }
    } finally { wipe(opened.vaultKey); if (discoveryKey) wipe(discoveryKey) }
  }

  private async commitUpdate(
    vault: EncryptedVaultSummary, detail: EntryDetail, previous: MemberSecretV1, next: MemberSecretV1,
    vaultKey: Uint8Array, discoveryKey: Uint8Array, authorized: () => Promise<boolean>, assertEpoch: () => void,
  ) {
    if (next.entryType !== previous.entryType || (next.entryType !== 'credential' && next.entryType !== 'creditCard')) throw new Error('Capture update changed the Entry type')
    const revision = (BigInt(detail.currentRevision) + 1n).toString()
    assertEpoch()
    const coordinates = { organizationId: vault.organizationId, vaultId: vault.id,
      entryId: detail.id, revision, entryKeyRevision: '1', entryKeyVersion: detail.currentKeyVersion + 1,
      memberIndexRevision: (BigInt(detail.memberIndexRevision) + 1n).toString(),
      agentDiscoveryRevision: (BigInt(detail.agentDiscoveryRevisionHighWatermark) + 1n).toString(),
      vaultKeyVersion: vault.currentKeyEpoch.vaultKeyVersion, vdkVersion: vault.currentKeyEpoch.vdkVersion,
      memberKeyGeneration: vault.memberKeyGeneration,
    }
    const material = next.entryType === 'credential'
      ? await sealCanonicalCredentialEntry(coordinates, next, vaultKey, discoveryKey, 2)
      : await sealCurrentCanonicalEntry(coordinates, next, vaultKey, discoveryKey, 2)
    const grants = await this.withAuth((token) => this.deps.client.getActiveGrants(token, vault.id))
    const grantMaterial = await this.grants(grants, vault, detail, next, revision, vaultKey)
    const project = (secret: MemberSecretV1) => secret.entryType === 'credential' ? projectCanonicalCredentialDiscovery(secret) : currentVaultPlaintext.projectAgentDiscovery(secret)
    const discoveryChanged = JSON.stringify(project(previous)) !== JSON.stringify(project(next))
    return this.withAuth(async (token) => {
      if (!(await authorized())) throw new VaultDataError('locked', 'Credential authorization changed')
      assertEpoch()
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
    url: string, scope: 'exact-host' | 'related-login-comparison' | 'manual-totp' = 'exact-host') {
    assertCoordinates(detail, vault, entryId)
    const secret = await openCurrentMemberSecret(detail.entryKey, detail.memberSecret, key,
      { organizationId: vault.organizationId, vaultId: vault.id, entryId, revision: detail.currentRevision })
    if (secret.entryType !== 'credential' || scope !== 'manual-totp' && !matchesTab(url, secret.content.urlDomain,
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

function methodStates(secret: MemberSecretV1): SignInBindingState[] {
 const methods = readSignInMethods(secret);
 return methods.length ? methods.map(method => ({ status: 'recognized' as const, fieldId: method.id, binding: method.binding })) : [{ status: 'absent' }];
}

function normalizedPan(value: string): string {
  const pan = value.replace(/[ -]/g, '')
  if (!/^\d{12,19}$/.test(pan)) throw new Error('Invalid card number')
  return pan
}
function editableCardField(field: { id: string; label: string; type: string; value: unknown }): field is import('./service').ManualCustomFieldInput {
  return isManualCustomFields([field])
}
