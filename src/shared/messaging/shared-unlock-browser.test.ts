import { describe, expect, it } from "vitest";
import { SHARED_UNLOCK_BROWSER_PORT, isSharedUnlockBrowserMessage } from "./shared-unlock-browser";
const hello = { type: "hello", protocol: SHARED_UNLOCK_BROWSER_PORT, apiUrl: "https://api.example.test", webNonce: "A".repeat(43) };
const ready = { ...hello, type: "ready", webOrigin: "https://app.example.test", extensionId: "a".repeat(32), channelId: "E".repeat(43), documentBinding: "7/document/channel" };
describe("private browser channel framing", () => {
  it.each([hello, ready])("accepts only its complete vocabulary ($type)", message => expect(isSharedUnlockBrowserMessage(message)).toBe(true));
  it.each([null, [], {}, { ...hello, type: "offer" }, { ...hello, accessToken: "synthetic" }, { ...ready, key: "synthetic" },
    { ...hello, protocol: "other" }, { ...hello, apiUrl: "" }, { ...hello, apiUrl: "a".repeat(2049) },
    { ...hello, webNonce: "A".repeat(42) }, { ...hello, webNonce: "A".repeat(42) + "B" },
    { ...ready, channelId: "A".repeat(44) }, { ...ready, extensionId: "z".repeat(32) },
    { ...ready, documentBinding: "" }, { ...ready, documentBinding: "a".repeat(257) }, { ...ready, webOrigin: "" },
  ])("rejects malformed, expanded or noncanonical frame %#", message => expect(isSharedUnlockBrowserMessage(message)).toBe(false));
});
