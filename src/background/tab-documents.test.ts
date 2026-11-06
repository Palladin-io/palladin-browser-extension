import { describe, expect, it } from "vitest";

import { browserDocumentIdForTab, registerTopFrameDocument, verifyLiveShareDocument } from "./tab-documents";

function port(sender: Partial<chrome.runtime.MessageSender>): chrome.runtime.Port {
  return { sender } as chrome.runtime.Port;
}

describe("top-frame browser document registry", () => {
  it("registers the browser-issued document and removes only that registration", () => {
    const removeFirst = registerTopFrameDocument(port({
      id: "extension-id",
      frameId: 0,
      tab: { id: 81 } as chrome.tabs.Tab,
      documentId: "browser-document-1",
    }), "extension-id");
    const removeSecond = registerTopFrameDocument(port({
      id: "extension-id",
      frameId: 0,
      tab: { id: 81 } as chrome.tabs.Tab,
      documentId: "browser-document-2",
    }), "extension-id");

    expect(browserDocumentIdForTab(81)).toBe("browser-document-2");
    removeFirst?.();
    expect(browserDocumentIdForTab(81)).toBe("browser-document-2");
    removeSecond?.();
    expect(browserDocumentIdForTab(81)).toBeNull();
  });

  it("rejects foreign, subframe, or unbound ports", () => {
    expect(registerTopFrameDocument(port({
      id: "other-extension",
      frameId: 0,
      tab: { id: 82 } as chrome.tabs.Tab,
      documentId: "browser-document",
    }), "extension-id")).toBeNull();
    expect(registerTopFrameDocument(port({
      id: "extension-id",
      frameId: 1,
      tab: { id: 82 } as chrome.tabs.Tab,
      documentId: "browser-document",
    }), "extension-id")).toBeNull();
    expect(registerTopFrameDocument(port({
      id: "extension-id",
      frameId: 0,
      tab: { id: 82 } as chrome.tabs.Tab,
    }), "extension-id")).toBeNull();
  });

  it("rejects a URL reply after the browser document changes at the same URL", async () => {
    const sender = (documentId: string) => port({ id: "extension-id", frameId: 0,
      tab: { id: 83 } as chrome.tabs.Tab, documentId });
    const removeFirst = registerTopFrameDocument(sender("old-document"), "extension-id");
    let finishReply: ((value: unknown) => void) | undefined;
    const reply = new Promise<unknown>(resolve => { finishReply = resolve; });
    const source = { tabId: 83, documentId: "old-document", url: "https://stage.palladin.io/share/123",
      webOrigin: "https://stage.palladin.io", apiUrl: "https://api.stage.palladin.io" };
    const verification = verifyLiveShareDocument(source, () => reply,
      (value): value is { url: string } => !!value && typeof value === "object" && "url" in value);
    const removeSecond = registerTopFrameDocument(sender("new-document"), "extension-id");
    finishReply?.({ url: source.url });
    expect(await verification).toBe(false);
    removeFirst?.();
    removeSecond?.();
  });
});

it('invalidates capture only when the registered top document is replaced or disconnected', () => {
  let invalidations = 0;
  const changed = () => { invalidations++; };
  const make = (documentId: string, frameId = 0) => port({ id: 'extension', frameId, tab: { id: 91 } as chrome.tabs.Tab, documentId });
  const first = registerTopFrameDocument(make('top-document'), 'extension', changed);
  expect(invalidations).toBe(0);
  expect(registerTopFrameDocument(make('child-document', 1), 'extension', changed)).toBeNull();
  expect(invalidations).toBe(0);
  const next = registerTopFrameDocument(make('replacement-document'), 'extension', changed);
  expect(invalidations).toBe(1);
  first?.();
  expect(invalidations).toBe(1);
  next?.();
  expect(invalidations).toBe(2);
});
