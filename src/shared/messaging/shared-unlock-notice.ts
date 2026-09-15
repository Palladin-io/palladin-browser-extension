/** Private extension-page presentation channel; never part of the page bridge. */
export const SHARED_UNLOCK_NOTICE_PORT = 'palladin.shared-unlock.notice.v1';
export interface SharedUnlockNoticeVisibility { readonly type: 'visibility'; readonly visible: boolean }
export type SharedUnlockNotice = { readonly type: 'completed'; readonly occurredAt: number } | { readonly type: 'clear' };

export function isSharedUnlockNoticeVisibility(value: unknown): value is SharedUnlockNoticeVisibility {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && row.type === 'visibility' && typeof row.visible === 'boolean';
}

export function isSharedUnlockNotice(value: unknown): value is SharedUnlockNotice {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.type === 'clear' ? Object.keys(row).length === 1
    : row.type === 'completed' && Object.keys(row).length === 2
      && typeof row.occurredAt === 'number' && Number.isSafeInteger(row.occurredAt) && row.occurredAt >= 0;
}
