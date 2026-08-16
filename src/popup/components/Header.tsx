import type { SessionStatus } from "../../background/session/types";
import brandLogoUrl from "../../../icons/logo-source.png";
import { useI18n, type TranslationKey } from "../i18n";

/**
 * Popup header: the Palladin brand lockup plus a small status chip mirroring the
 * lock state, so the coarse session state is visible on every screen (matching
 * the toolbar badge). Hidden on the initial `loading` phase where the state
 * isn't known yet.
 */
export interface HeaderProps {
  status?: SessionStatus | undefined;
  settingsOpen?: boolean;
  onToggleSettings?(): void;
}

const CHIP: Record<SessionStatus, { label: TranslationKey; dot: string }> = {
  unlocked: { label: "status.unlocked", dot: "status-dot--unlocked" },
  locked: { label: "status.locked", dot: "status-dot--locked" },
  "signed-out": { label: "status.signedOut", dot: "" },
};

export function Header({
  status,
  settingsOpen = false,
  onToggleSettings,
}: HeaderProps): React.JSX.Element {
  const { t } = useI18n();
  const chip = status ? CHIP[status] : null;
  return (
    <header className="popup-header">
      <div className="brand-lockup">
        <img className="brand-logo" src={brandLogoUrl} alt="" aria-hidden="true" />
        <h1 className="wordmark" aria-label="Palladin.io">
          <span>Palladin</span><span className="wordmark-tld">.io</span>
        </h1>
      </div>
      <div className="popup-header-actions">
        {chip ? (
          <span className="status-chip" role="status">
            <span className={`status-dot ${chip.dot}`.trim()} aria-hidden="true" />
            {t(chip.label)}
          </span>
        ) : null}
        {onToggleSettings ? (
          <button type="button" className="header-link" onClick={onToggleSettings}>
            {settingsOpen ? t("common.back") : t("common.settings")}
          </button>
        ) : null}
      </div>
    </header>
  );
}
