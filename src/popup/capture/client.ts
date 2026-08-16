import type {
  CaptureGeneratedFillResult,
  CapturePopupCommand,
  CapturePopupResult,
  CapturePromptView,
  CaptureSaveResult,
} from "@shared/messaging/capture";

export interface CaptureClient {
  getPrompt(): Promise<CapturePromptView | null>;
  dismiss(promptId: string): Promise<void>;
  fillGenerated(promptId: string, value: string): Promise<CaptureGeneratedFillResult>;
  save(promptId: string, value: string): Promise<CaptureSaveResult>;
}

export type CaptureSend = (
  command: CapturePopupCommand,
) => Promise<CapturePopupResult | undefined>;

type SuccessfulCapturePopupResult = Extract<CapturePopupResult, { readonly ok: true }>;

const chromeSend: CaptureSend = async (command) => {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return undefined;
  return chrome.runtime.sendMessage(command) as Promise<CapturePopupResult | undefined>;
};

async function dispatch(
  send: CaptureSend,
  command: CapturePopupCommand,
): Promise<SuccessfulCapturePopupResult> {
  const result = await send(command);
  if (result === undefined || !result.ok) throw new Error("Capture command unavailable");
  return result;
}

export function createCaptureClient(send: CaptureSend = chromeSend): CaptureClient {
  return {
    async getPrompt() {
      const result = await dispatch(send, { type: "capture/prompt/get" });
      if (result.kind !== "prompt") throw new Error("Unexpected capture response");
      return result.prompt;
    },
    async dismiss(promptId) {
      const result = await dispatch(send, { type: "capture/prompt/dismiss", promptId });
      if (result.kind !== "dismissed") throw new Error("Unexpected capture response");
    },
    async fillGenerated(promptId, value) {
      const result = await dispatch(send, {
        type: "capture/prompt/fill-generated",
        promptId,
        value,
      });
      if (result.kind !== "fill") throw new Error("Unexpected capture response");
      return result.fill;
    },
    async save(promptId, value) {
      const result = await dispatch(send, { type: "capture/prompt/save", promptId, value });
      if (result.kind !== "save") throw new Error("Unexpected capture response");
      return result.save;
    },
  };
}
