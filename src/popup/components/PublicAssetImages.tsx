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
  // The selected API is the authority; the URL inside decrypted presentation is not.
  const url = apiUrl !== null && reference !== null
    ? `${apiUrl}/api/public-assets/${reference.assetId}/revisions/${reference.revision}/content`
    : null;
  const [loaded, setLoaded] = useState<{ source: string; blob: string } | null>(null);
  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void loadImage(url, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ source: url, blob: objectUrl });
    }).catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  return loaded?.source === url ? loaded.blob : null;
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
