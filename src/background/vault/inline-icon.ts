import { loadPublicAssetIcon } from "@shared/public-asset-image";

export async function loadInlineIcon(apiUrl: string, icon: string): Promise<string | undefined> {
  try {
    const blob = await loadPublicAssetIcon(apiUrl, icon, AbortSignal.timeout(1500));
    if (!blob) return undefined;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:image/png;base64,${btoa(binary)}`;
  } catch {
    return undefined;
  }
}
