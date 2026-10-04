import { RotatingWelcome } from "./RotatingWelcome";
import { PopupIcon } from "./PopupIcon";
import type { ReactNode } from "react";
import type { SessionStatus } from "../../background/session/types";
import brandLogoUrl from "../../../icons/logo-source.png";
import { useI18n, type TranslationKey } from "../i18n";

/**
 * Popup header: the Palladin brand lockup plus a small status chip mirroring the
 * lock state, so the coarse session state is visible on every screen. Hidden
 * on the initial `loading` phase where the state
 * isn't known yet.
 */
export interface HeaderProps {
  children?: ReactNode;
  authBrand?: boolean;
  status?: SessionStatus | undefined;
  settingsOpen?: boolean;
  contextLabel?: TranslationKey | undefined;
  onToggleSettings?(): void;
}

const CHIP: Record<SessionStatus, { label: TranslationKey; dot: string }> = {
  unlocked: { label: "status.unlocked", dot: "status-dot--unlocked" },
  locked: { label: "status.locked", dot: "status-dot--locked" },
  "signed-out": { label: "status.signedOut", dot: "" },
};

export function Header({
  children,
  authBrand = false,
  status,
  settingsOpen = false,
  contextLabel,
  onToggleSettings,
}: HeaderProps): React.JSX.Element {
  const { t } = useI18n();
  const chip = status ? CHIP[status] : null;
  return (
    <header className={authBrand ? "popup-header auth-brand-header" : "popup-header"}>
      <div className="brand-lockup">
        <img className="brand-logo" src={brandLogoUrl} alt="" aria-hidden="true" />
        <h1 className="wordmark" aria-label="Palladin.io">
          <span>Palladin</span><span className="wordmark-tld">.io</span>
        </h1>
      </div>
      {authBrand ? <RotatingWelcome /> : null}
      {children}
      <div className="popup-header-actions">
        {contextLabel ? (
          <span className="header-context-label">{t(contextLabel)}</span>
        ) : null}
        {chip ? (
          <span className="status-chip" role="status">
            <span className={`status-dot ${chip.dot}`.trim()} aria-hidden="true" />
            {t(chip.label)}
          </span>
        ) : null}
        {onToggleSettings ? (
          <button type="button" className="toolbar-icon" aria-label={settingsOpen ? t("common.back") : t("common.settings")} title={settingsOpen ? t("common.back") : t("common.settings")} onClick={onToggleSettings}>
            <PopupIcon name={settingsOpen ? "back" : "settings"} />
          </button>
        ) : null}
      </div>
    </header>
  );
}
