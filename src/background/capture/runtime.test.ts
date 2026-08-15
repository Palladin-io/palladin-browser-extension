import { describe, expect, it } from "vitest";

import { captureSourceFromSender } from "./runtime";

describe("captureSourceFromSender", () => {
  it("accepts only the extension's HTTPS top-frame content script", () => {
    const sender = {
      id: "extension-id",
      frameId: 0,
      documentId: "browser-document-1",
      url: "https://accounts.example.com/register",
      tab: { id: 7, url: "https://accounts.example.com/register" },
    } as chrome.runtime.MessageSender;
    expect(captureSourceFromSender(sender, "extension-id")).toEqual({
      tabId: 7,
      url: "https://accounts.example.com/register",
      browserDocumentId: "browser-document-1",
    });
  });

  it("rejects subframes, foreign senders, insecure pages, and changed origins", () => {
    const base = {
      id: "extension-id",
      frameId: 0,
      documentId: "browser-document-1",
      url: "https://accounts.example.com/register",
      tab: { id: 7, url: "https://accounts.example.com/register" },
    } as chrome.runtime.MessageSender;
    expect(captureSourceFromSender({ ...base, frameId: 2 }, "extension-id")).toBeNull();
    expect(captureSourceFromSender({ ...base, id: "foreign" }, "extension-id")).toBeNull();
    expect(captureSourceFromSender({ ...base, documentId: undefined }, "extension-id")).toBeNull();
    expect(captureSourceFromSender({ ...base, url: "http://accounts.example.com/register" }, "extension-id")).toBeNull();
    expect(captureSourceFromSender({
      ...base,
      url: "https://evil.example.net/register",
    }, "extension-id")).toBeNull();
  });
});
