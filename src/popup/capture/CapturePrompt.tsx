import type { CapturePromptView } from "@shared/messaging/capture";

import { Button } from "../components/Button";

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
  const title = prompt.kind === "registration"
    ? "New password form detected"
    : "Password change detected";
  return (
    <section className="capture-prompt" aria-labelledby="capture-prompt-title">
      <h3 id="capture-prompt-title">{title}</h3>
      <p>Generate and fill a strong password for {prompt.site}, then choose whether to save it.</p>
      <div className="capture-actions">
        <Button onClick={onUseStrongPassword}>Use strong password</Button>
        <Button variant="ghost" onClick={onDismiss}>Not now</Button>
      </div>
    </section>
  );
}
