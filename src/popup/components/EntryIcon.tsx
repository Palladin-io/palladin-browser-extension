import { PopupIcon } from "./PopupIcon";
import { useState } from "react";
import { usePublicAssetImage } from "./PublicAssetImages";

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

export function EntryIcon({ name, type, icon, color }: EntryIconProps): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageUrl = usePublicAssetImage(icon);
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

function TypeIcon({ type }: { readonly type: EntryTypeCode }): React.JSX.Element {
  const name = type === ENTRY_TYPE_CREDENTIAL ? 'key'
    : type === ENTRY_TYPE_KEY ? 'terminal'
    : type === ENTRY_TYPE_CREDIT_CARD ? 'card' : 'script';
  return <PopupIcon name={name} />;
}
