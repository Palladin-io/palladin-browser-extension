import type { MemberSecretV1 } from '@palladin/crypto';
import type { ManualEntrySaveInput } from '../vault/protocol2/service';
export function isExactCapturedSecret(entry: ManualEntrySaveInput, previous: MemberSecretV1): boolean {
  if (entry.entryType === 'key' && previous.entryType === 'key') return previous.content.value === entry.value;
  return entry.entryType === 'creditCard' && previous.entryType === 'creditCard'
    && previous.content.cardNumber === entry.cardNumber.replace(/[ -]/g, '')
    && previous.content.cardholderName === entry.cardholderName && previous.content.expiryMonth === entry.expiryMonth
    && previous.content.expiryYear === entry.expiryYear && (previous.content.cvv ?? '') === (entry.cvv ?? '')
    && (previous.content.billingAddress ?? '') === (entry.billingAddress ?? '');
}
