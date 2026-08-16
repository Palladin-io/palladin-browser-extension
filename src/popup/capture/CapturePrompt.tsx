import type { CapturePromptView } from "@shared/messaging/capture";

import { Button } from "../components/Button";
import { useI18n } from "../i18n";

export interface CapturePromptProps {
  readonly prompt: CapturePromptView;
  onUseStrongPassword(): void;
  onDismiss(): void;
}

export function CapturePrompt({
  prompt,
  onUseStrongPassword,
  onDismiss,
}: CapturePromptProps): React.JSX.Element {
  const { t } = useI18n();
  const title = prompt.kind === "registration"
    ? t("capture.registration")
    : t("capture.passwordChange");
  return (
    <section className="capture-prompt" aria-labelledby="capture-prompt-title">
      <h3 id="capture-prompt-title">{title}</h3>
      <p>{t("capture.description", { site: prompt.site })}</p>
      <div className="capture-actions">
        <Button onClick={onUseStrongPassword}>{t("capture.useStrong")}</Button>
        <Button variant="ghost" onClick={onDismiss}>{t("capture.notNow")}</Button>
      </div>
    </section>
  );
}
