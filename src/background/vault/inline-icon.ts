import { parsePublicAssetIconReference } from "@palladin/crypto";
import { loadPublicAssetPng } from "@shared/public-asset-image";

export async function loadInlineIcon(apiUrl: string, icon: string): Promise<string | undefined> {
  const reference = parsePublicAssetIconReference(icon);
  if (!reference) return undefined;
  try {
    // Never fetch the URL carried by decrypted metadata or send page referrers.
    const blob = await loadPublicAssetPng(
      `${apiUrl}/api/public-assets/${reference.assetId}/revisions/${encodeURIComponent(reference.revision)}/content`,
      AbortSignal.timeout(1500),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:image/png;base64,${btoa(binary)}`;
  } catch {
    return undefined;
  }
}
