import { parsePublicAssetIconReference } from "@palladin/crypto";

const MAXIMUM_IMAGE_BYTES = 1024 * 1024;

export async function loadPublicAssetPng(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, {
    signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
  });
  if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "image/png" || !response.body) {
    await response.body?.cancel();
    throw new Error("Public icon unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAXIMUM_IMAGE_BYTES) throw new Error("Public icon exceeds image budget");
      chunks.push(new Uint8Array(value));
    }
    return new Blob(chunks, { type: "image/png" });
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function loadPublicAssetIcon(apiUrl: string, icon: string, signal: AbortSignal): Promise<Blob | null> {
  let asset: { assetId: string; revision: number } | null = parsePublicAssetIconReference(icon);
  const catalogId = /^public-asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(icon)?.[1];
  if (!asset && catalogId) {
    const response = await fetch(`${apiUrl}/api/public-assets/by-ids`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetIds: [catalogId] }),
      signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error('Public icon unavailable');
    const page = await response.json() as { items: { id: string; revision: number }[] };
    const match = page.items.find(item => item.id === catalogId);
    if (!match) return null;
    asset = { assetId: catalogId, revision: match.revision };
  }
  if (!asset) return null;
  // Catalog/decrypted URLs never become image destinations; only the selected API serves PNG bytes.
  return loadPublicAssetPng(`${apiUrl}/api/public-assets/${asset.assetId}/revisions/${encodeURIComponent(asset.revision)}/content`, signal);
}
