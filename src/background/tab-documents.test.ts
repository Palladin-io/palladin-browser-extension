import { describe, expect, it } from "vitest";

import { browserDocumentIdForTab, registerTopFrameDocument } from "./tab-documents";

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
});
