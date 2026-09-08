// Presentation filter only: the backend authorizes VaultManage and membership on every write.
export function hasVaultManagePermission(accessToken: string | null): boolean {
  if (!accessToken) return false;
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return false;
    const decoded: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (decoded === null || typeof decoded !== 'object') return false;
    const permissions = (decoded as Record<string, unknown>).permissions;
    if (typeof permissions === 'number' && Number.isSafeInteger(permissions) && permissions >= 0) {
      return (BigInt(permissions) & 8n) !== 0n;
    }
    return typeof permissions === 'string' && /^[0-9]{1,20}$/.test(permissions)
      && (BigInt(permissions) & 8n) !== 0n;
  } catch { return false; }
}
