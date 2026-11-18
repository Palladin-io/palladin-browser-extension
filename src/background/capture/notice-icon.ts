import type { CaptureNoticeIdentity } from '@shared/messaging/capture-notice';
export async function resolveCaptureNoticeIcon(notice: CaptureNoticeIdentity,
  resolve: (url: string) => Promise<string | undefined>, load: (icon: string) => Promise<string | undefined>): Promise<CaptureNoticeIdentity> {
  if (notice.kind === 'card') return notice;
  try {
    const icon = await resolve(`https://${notice.site}`);
    const image = icon ? await load(icon) : undefined;
    return image ? { ...notice, iconDataUrl: image } : notice;
  } catch { return notice; }
}
