import { useState } from "react";
import { parsePublicAssetIconReference } from "@palladin/crypto";

import {
  ENTRY_TYPE_CREDENTIAL,
  ENTRY_TYPE_CREDIT_CARD,
  ENTRY_TYPE_KEY,
  type EntryTypeCode,
} from "../../background/vault/entry-metadata";

export interface EntryIconProps {
  name: string;
  type: EntryTypeCode;
  icon?: string;
  color?: string;
}

/**
 * Entry avatar shared by every popup row. Published catalog images are accepted
 * only from the same immutable origins as the web panel; encrypted/private
 * assets and failed images fall back to a local type icon without any network
 * lookup or broken-image placeholder.
 */
export function EntryIcon({ name, type, icon, color }: EntryIconProps): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const publicAsset = parsePublicAssetIconReference(icon);
  const imageUrl = publicAsset === null ? null : trustedPublicAssetUrl(publicAsset.url);
  const style = color ? { backgroundColor: color, color: "#fff" } : undefined;
  const label = name.trim() || "Entry";

  return (
    <span className="entry-icon" style={style} aria-hidden="true" title={label}>
      {imageUrl !== null && failedUrl !== imageUrl ? (
        <img
          className="entry-icon-image"
          src={imageUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(imageUrl)}
        />
      ) : (
        <TypeIcon type={type} />
      )}
    </span>
  );
}

function trustedPublicAssetUrl(value: string): string | null {
  try {
    const candidate = new URL(value);
    if (candidate.username !== "" || candidate.password !== ""
      || candidate.search !== "" || candidate.hash !== "") return null;
    const bases = [
      new URL("https://assets.palladin.io/"),
      new URL("http://localhost:4566/palladin-local-public-assets/"),
    ];
    return bases.some((base) => candidate.origin === base.origin
      && candidate.pathname.startsWith(base.pathname))
      ? candidate.toString()
      : null;
  } catch {
    return null;
  }
}

function TypeIcon({ type }: { readonly type: EntryTypeCode }): React.JSX.Element {
  if (type === ENTRY_TYPE_CREDENTIAL) {
    return <svg className="entry-icon-glyph" viewBox="0 0 24 24"><path d="M7.5 10V7.8a4.5 4.5 0 0 1 9 0V10m-10 0h11a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5v-7A1.5 1.5 0 0 1 6.5 10Zm5.5 4.4v2.4" /></svg>;
  }
  if (type === ENTRY_TYPE_KEY) {
    return <svg className="entry-icon-glyph" viewBox="0 0 24 24"><path d="M14.5 9.5a4 4 0 1 1-1.1-2.8L21 6.7v3h-2v2h-3v2h-2.3" /><circle cx="7.5" cy="9.5" r=".7" fill="currentColor" stroke="none" /></svg>;
  }
  if (type === ENTRY_TYPE_CREDIT_CARD) {
    return <svg className="entry-icon-glyph" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18M7 15h4" /></svg>;
  }
  return <svg className="entry-icon-glyph" viewBox="0 0 24 24"><path d="m8 8-4 4 4 4m8-8 4 4-4 4m-2-11-4 14" /></svg>;
}
