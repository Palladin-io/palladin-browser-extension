import { currentVaultPlaintext, defaultCredentialAgentFieldAccess, parseOtpauthUri, wipe } from '@palladin/crypto';
import { shareSnapshot, type ShareSnapshot } from '../../shared/messaging/share-save';

type AgentFieldAccess = currentVaultPlaintext.AgentFieldAccess;
type MemberSecretV1 = currentVaultPlaintext.MemberSecretV1;

/** A received page snapshot is untrusted even though its page belongs to Palladin. */
export function sharedCopySecret(raw: unknown): MemberSecretV1 {
  const parsed = shareSnapshot.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid shared copy');
  const source: ShareSnapshot = parsed.data;
  if (source.title.length > 256 || source.title !== source.title.normalize('NFC')) throw new Error('Invalid shared copy');
  // The web canonical writer normalizes native values. A handoff must never
  // silently change the received plaintext; reject noncanonical input instead.
  for (const field of source.fields) {
    if (field.value !== field.value.normalize('NFC') || field.label !== field.label.normalize('NFC')) {
      throw new Error('Invalid shared copy');
    }
  }
  const values = new Map(source.fields.map(item => [item.id, item.value]));
  const value = (id: string): string | null => values.get(id) ?? null;
  const customFields = source.fields.filter(item => item.id.startsWith('custom:')).map(item => {
    const parsedTotp = item.type === 'totp' ? parseOtpauthUri(item.value) : null;
    if (item.type === 'totp' && (!parsedTotp || ![6, 8].includes(parsedTotp.digits))) {
      throw new Error('Invalid shared copy');
    }
    return { id: `custom:${crypto.randomUUID()}`, label: item.label, type: item.type,
      value: parsedTotp ? { ...parsedTotp, issuer: parsedTotp.issuer ?? null, account: parsedTotp.account ?? null } : item.value };
  });
  const common = {
    schema: 'palladin.member-secret.v1' as const,
    memberLabel: source.title,
    agentLabel: source.title,
    discoverable: true,
    description: value('description'),
    icon: null,
    color: null,
  };
  const policy: Record<string, AgentFieldAccess> = {
    memberLabel: 'never', agentLabel: 'discovery', description: source.entryType === 'script' ? 'discovery' : 'never',
    icon: 'never', color: 'never', entryType: 'discovery',
    notes: source.entryType === 'script' || source.entryType === 'creditCard' ? 'never' : 'onGrantValue',
  };
  for (let i = 0; i < customFields.length; i++) {
    const field = customFields[i]!;
    policy[field.id] = source.entryType === 'creditCard' ? 'never'
      : field.type === 'totp' ? 'onGrantDerived'
        : source.entryType === 'script' ? 'onGrantRuntime' : 'onGrantValue';
  }
  let secret: MemberSecretV1;
  if (source.entryType === 'credential') {
    const uri = value('credential.totp');
    const totp = uri ? parseOtpauthUri(uri) : null;
    if (uri && (!totp || ![6, 8].includes(totp.digits))) throw new Error('Invalid shared copy');
    const url = value('credential.url');
    let urlDomain: string | null = null;
    if (url) { try { urlDomain = new URL(url).hostname.toLowerCase(); } catch { /* no domain matches web copy */ } }
    Object.assign(policy, defaultCredentialAgentFieldAccess(customFields));
    secret = { ...common, entryType: 'credential', agentFieldAccess: policy, content: {
      username: value('credential.username') ?? '', password: value('credential.password') ?? '',
      url, urlDomain, totp: totp ? { ...totp, digits: totp.digits as 6 | 8,
        issuer: totp.issuer ?? null, account: totp.account ?? null } : null,
      notes: value('notes'), customFields,
    } };
  } else if (source.entryType === 'key') {
    const url = value('key.url');
    Object.assign(policy, { 'key.value': 'onGrantValue', ...(url !== null ? { 'key.url': 'onGrantValue' } : {}) });
    secret = { ...common, entryType: 'key', agentFieldAccess: policy, content: {
      value: value('key.value') ?? '', url, notes: value('notes'), customFields,
    } };
  } else if (source.entryType === 'script') {
    const interpreter = value('script.interpreter');
    if (interpreter !== 'bash' && interpreter !== 'sh' && interpreter !== 'node' && interpreter !== 'python') {
      throw new Error('Invalid shared copy');
    }
    Object.assign(policy, { 'script.source': 'onGrantRuntime', 'script.interpreter': 'discovery', 'script.refs': 'onGrantRuntime' });
    secret = { ...common, entryType: 'script', agentFieldAccess: policy, content: {
      source: value('script.source') ?? '', interpreter, refs: [], notes: value('notes'), customFields,
    } };
  } else {
    const cardholderName = value('creditCard.cardholderName');
    const cardNumber = value('creditCard.cardNumber');
    const expiryMonth = value('creditCard.expiryMonth');
    const expiryYear = value('creditCard.expiryYear');
    if (!cardholderName || !cardNumber || !/^\d{12,19}$/.test(cardNumber)
      || !expiryMonth || !/^(0[1-9]|1[0-2])$/.test(expiryMonth)
      || !expiryYear || !/^\d{4}$/.test(expiryYear)) throw new Error('Invalid shared copy');
    Object.assign(policy, { 'creditCard.cardholderName': 'never', 'creditCard.cardNumber': 'never',
      'creditCard.expiryMonth': 'never', 'creditCard.expiryYear': 'never', 'creditCard.billingAddress': 'never' });
    const cvv = value('creditCard.cvv');
    if (cvv !== null) policy['creditCard.cvv'] = 'never';
    secret = { ...common, entryType: 'creditCard', agentFieldAccess: policy, content: {
      cardholderName, cardNumber, ...(cvv !== null ? { cvv } : {}), expiryMonth, expiryYear,
      billingAddress: value('creditCard.billingAddress'), notes: value('notes'), customFields,
    } };
  }
  // The canonical package is the independent storage contract; encoding before
  // mutation catches unsupported values instead of dropping individual fields.
  const encoded = currentVaultPlaintext.encodeMemberSecret(secret);
  wipe(encoded);
  return secret;
}
