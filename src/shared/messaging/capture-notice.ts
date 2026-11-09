export interface CaptureNoticeIdentity {
  kind: 'credential' | 'card' | 'key' | 'totp';
  site: string;
  name: string;
  detail: string;
  cardBrand?: 'Visa' | 'Mastercard' | 'American Express';
  iconDataUrl?: string;
}
export function isCaptureNoticeIdentity(value: unknown): value is CaptureNoticeIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const text = (key: string, max: number) => typeof item[key] === 'string' && item[key].length <= max && !/[\u0000-\u001f\u007f]/.test(item[key]);
  return Object.keys(item).every(key => ['kind','site','name','detail','cardBrand','iconDataUrl'].includes(key))
    && ['credential','card','key','totp'].includes(String(item.kind)) && text('site',253) && text('name',4096) && text('detail',4096)
    && (item.cardBrand === undefined || ['Visa','Mastercard','American Express'].includes(String(item.cardBrand)))
    && (item.iconDataUrl === undefined || typeof item.iconDataUrl === 'string' && item.iconDataUrl.length <= 1400000
      && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(item.iconDataUrl));
}
