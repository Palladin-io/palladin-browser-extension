import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { parsePublicAssetIconReference } from "@palladin/crypto";
import { normalizeServerUrl } from "@shared/config/server";
import type { ServerConfigClient } from "../config/client";

const ApiUrlContext = createContext<string | null>(null);
const MAXIMUM_IMAGE_BYTES = 1024 * 1024;

export function PublicAssetImages({ client, children }: {
  client: ServerConfigClient;
  children: ReactNode;
}): React.JSX.Element {
  const [apiUrl, setApiUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setApiUrl(null);
    void client.get().then(({ apiUrl: value }) => {
      if (active) setApiUrl(normalizeServerUrl(value));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [client]);
  return <ApiUrlContext.Provider value={apiUrl}>{children}</ApiUrlContext.Provider>;
}

export function usePublicAssetImage(icon: string | undefined): string | null {
  const apiUrl = useContext(ApiUrlContext);
  const reference = parsePublicAssetIconReference(icon);
  const catalogId = /^public-asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(icon ?? '')?.[1];
  const source = apiUrl && (reference || catalogId) ? `${apiUrl}|${icon}` : null;
  const [loaded, setLoaded] = useState<{ source: string; blob: string } | null>(null);
  useEffect(() => {
    if (!apiUrl || !source) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void (async () => {
      let asset: { assetId: string; revision: number } | null = reference;
      if (!asset && catalogId) {
        const response = await fetch(`${apiUrl}/api/public-assets/by-ids`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetIds: [catalogId] }),
          signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        });
        if (!response.ok) throw new Error('Public icon unavailable');
        const page = await response.json() as { items: { id: string; revision: number }[] };
        const match = page.items.find(item => item.id === catalogId);
        if (!match) return;
        asset = { assetId: catalogId, revision: match.revision };
      }
      if (!asset) return;
      // Only selected-API content is trusted; catalog/decrypted URLs never become image destinations.
      const blob = await loadImage(`${apiUrl}/api/public-assets/${asset.assetId}/revisions/${encodeURIComponent(asset.revision)}/content`, controller.signal);
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ source, blob: objectUrl });
    })().catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [apiUrl, source]);
  return source && loaded?.source === source ? loaded.blob : null;
}

async function loadImage(url: string, signal: AbortSignal): Promise<Blob> {
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
