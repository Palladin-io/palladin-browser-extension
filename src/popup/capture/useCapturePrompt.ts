import { useCallback, useEffect, useState } from "react";

import type { CapturePromptView } from "@shared/messaging/capture";

import type { CaptureClient } from "./client";

export interface CapturePromptState {
  readonly prompt: CapturePromptView | null;
  dismiss(): Promise<void>;
}

export function useCapturePrompt(client: CaptureClient): CapturePromptState {
  const [prompt, setPrompt] = useState<CapturePromptView | null>(null);

  useEffect(() => {
    let current = true;
    void client.getPrompt()
      .then((next) => {
        if (current) setPrompt(next);
      })
      .catch(() => {
        // Capture is optional and fail-closed. A missing worker prompt must not
        // interfere with normal vault use.
      });
    return () => {
      current = false;
    };
  }, [client]);

  const dismiss = useCallback(async (): Promise<void> => {
    if (prompt === null) return;
    await client.dismiss(prompt.id);
    setPrompt(null);
  }, [client, prompt]);

  return { prompt, dismiss };
}
