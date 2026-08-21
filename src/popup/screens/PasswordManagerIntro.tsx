import { useState } from "react";

import { Button } from "../components/Button";
import { useI18n } from "../i18n";

export interface PasswordManagerIntroProps {
  onContinue(): Promise<void>;
  onOpenPasswordSettings(): Promise<void>;
  onOpenExtensionManager(): Promise<void>;
}

export function PasswordManagerIntro({
  onContinue,
  onOpenPasswordSettings,
  onOpenExtensionManager,
}: PasswordManagerIntroProps): React.JSX.Element {
  const { t } = useI18n();
  const [continuing, setContinuing] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  return (
    <section className="manager-intro" aria-labelledby="manager-intro-title">
      <h2 id="manager-intro-title" className="manager-intro-title">
        {t("onboarding.managers.title")}
      </h2>
      <p className="manager-intro-copy">{t("onboarding.managers.subtitle")}</p>

      <ul className="manager-intro-recommendations">
        <li>{t("onboarding.managers.browser")}</li>
        <li>{t("onboarding.managers.extensions")}</li>
      </ul>

      <div className="manager-intro-shortcuts">
        <Button variant="subtle" onClick={() => open(onOpenPasswordSettings)}>
          {t("onboarding.managers.openPasswords")}
        </Button>
        <Button variant="subtle" onClick={() => open(onOpenExtensionManager)}>
          {t("onboarding.managers.openExtensions")}
        </Button>
      </div>

      {openFailed ? (
        <p className="manager-intro-error" role="alert">
          {t("onboarding.managers.openError")}
        </p>
      ) : null}

      <Button block loading={continuing} onClick={continueToPalladin}>
        {t("onboarding.managers.continue")}
      </Button>
      <p className="manager-intro-footnote">{t("onboarding.managers.once")}</p>
    </section>
  );

  function open(action: () => Promise<void>): void {
    setOpenFailed(false);
    void action().catch(() => setOpenFailed(true));
  }

  function continueToPalladin(): void {
    setContinuing(true);
    void onContinue().finally(() => setContinuing(false));
  }
}
