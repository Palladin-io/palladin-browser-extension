import { z } from 'zod';

// The page is an independent trust boundary. Keep this schema aligned with the
// public receiver's palladin.entry-share.v1 fixture; never trust its TS type.
const field = z.strictObject({
  id: z.string().min(1).max(160),
  label: z.string().max(256),
  type: z.enum(['text', 'multiline', 'concealed', 'totp']),
  value: z.string().max(262_144),
});
const nativeTypes: Readonly<Record<string, z.infer<typeof field>['type']>> = {
  'credential.username': 'text', 'credential.password': 'concealed', 'credential.url': 'text',
  'credential.totp': 'totp', 'key.value': 'concealed', 'key.url': 'text',
  'script.source': 'multiline', 'script.interpreter': 'text',
  'creditCard.cardholderName': 'text', 'creditCard.cardNumber': 'concealed',
  'creditCard.cvv': 'concealed', 'creditCard.expiryMonth': 'text',
  'creditCard.expiryYear': 'text', 'creditCard.billingAddress': 'multiline',
  notes: 'multiline', description: 'multiline',
};
export const shareSnapshot = z.strictObject({
  schema: z.literal('palladin.entry-share.v1'),
  title: z.string().min(1).max(512),
  entryType: z.enum(['key', 'credential', 'script', 'creditCard']),
  fields: z.array(field).min(1).max(256),
}).refine(value => new Set(value.fields.map(item => item.id)).size === value.fields.length)
  .refine(value => value.fields.every(item => item.id.startsWith('custom:') && item.id.length > 7
    || Object.hasOwn(nativeTypes, item.id) && nativeTypes[item.id] === item.type
      && (item.id === 'notes' || item.id === 'description' || item.id.startsWith(`${value.entryType}.`))));
export type ShareSnapshot = z.infer<typeof shareSnapshot>;

export const SHARE_SAVE_CHANNEL = 'palladin.entry-share.extension-save.v1';
const requestId = z.string().uuid();
export const sharePageRequest = z.discriminatedUnion('type', [
  z.strictObject({ channel: z.literal(SHARE_SAVE_CHANNEL), type: z.literal('status'), requestId }),
  z.strictObject({ channel: z.literal(SHARE_SAVE_CHANNEL), type: z.literal('prepare'), requestId,
    snapshot: shareSnapshot }),
]);
export type SharePageRequest = z.infer<typeof sharePageRequest>;
export const sharePageResponse = z.strictObject({
  channel: z.literal(SHARE_SAVE_CHANNEL), type: z.literal('response'), requestId,
  status: z.enum(['unavailable', 'locked', 'ready', 'pending']),
});
export type SharePageResponse = z.infer<typeof sharePageResponse>;

export const sharePopupCommand = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('share-save/get') }),
  z.strictObject({ type: z.literal('share-save/confirm'), pendingId: z.string().uuid(), vaultId: z.string().uuid() }),
  z.strictObject({ type: z.literal('share-save/cancel'), pendingId: z.string().uuid() }),
]);
export type SharePopupCommand = z.infer<typeof sharePopupCommand>;
