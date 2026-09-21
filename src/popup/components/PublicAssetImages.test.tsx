// @vitest-environment jsdom
import { render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EntryIcon } from "./EntryIcon";
import { PublicAssetImages } from "./PublicAssetImages";
import { ENTRY_TYPE_CREDENTIAL } from "../../background/vault/entry-metadata";

const assetId = "11111111-1111-4111-8111-111111111111";
const icon = `public-asset:${assetId}|1|${encodeURIComponent("https://untrusted.example/tracker.png")}`;
const fetchImage = vi.fn();
const createBlob = vi.fn(() => "blob:extension/icon");
const revokeBlob = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchImage);
  URL.createObjectURL = createBlob;
  URL.revokeObjectURL = revokeBlob;
  fetchImage.mockResolvedValue(new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { "content-type": "image/png" },
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function show(apiUrl: string) {
  const client = { get: vi.fn(async () => ({ apiUrl, changed: false })), save: vi.fn() };
  return render(<PublicAssetImages client={client}>
    <EntryIcon name="Example" type={ENTRY_TYPE_CREDENTIAL} icon={icon} />
  </PublicAssetImages>);
}

it.each(["https://api.stage.palladin.io", "https://vault.example/palladin", "http://localhost:5000"])(
  "loads immutable bytes only from selected API %s", async (apiUrl) => {
    const { container, unmount } = show(apiUrl);
    await waitFor(() => expect(container.querySelector("img")?.src).toBe("blob:extension/icon"));
    expect(fetchImage).toHaveBeenCalledExactlyOnceWith(
      `${apiUrl}/api/public-assets/${assetId}/revisions/1/content`,
      expect.objectContaining({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }),
    );
    unmount();
    expect(revokeBlob).toHaveBeenCalledWith("blob:extension/icon");
  },
);

it.each([
  new Response("not found", { status: 404 }),
  new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
  new Response(new Uint8Array(1024 * 1024 + 1), { headers: { "content-type": "image/png" } }),
])("keeps a local glyph for an unavailable or unsupported image", async (response) => {
  fetchImage.mockResolvedValue(response);
  const { container } = show("https://vault.example");
  await waitFor(() => expect(fetchImage).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(container.querySelector("img")).toBeNull();
  expect(createBlob).not.toHaveBeenCalled();
});

it("does not fetch from an invalid configured server", async () => {
  const { container } = show("https://user:password@vault.example");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fetchImage).not.toHaveBeenCalled();
  expect(container.querySelector("img")).toBeNull();
});
