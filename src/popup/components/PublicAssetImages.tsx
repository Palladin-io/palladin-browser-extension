import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { parsePublicAssetIconReference } from "@palladin/crypto";
import { normalizeServerUrl } from "@shared/config/server";
import type { ServerConfigClient } from "../config/client";

import { loadPublicAssetIcon } from "@shared/public-asset-image";

export const ApiUrlContext = createContext<string | null>(null);

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
      const blob = await loadPublicAssetIcon(apiUrl, icon!, controller.signal);
      if (!blob) return;
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
