import { afterEach, expect, it, vi } from "vitest";
import { loadInlineIcon } from "./inline-icon";
const id = "11111111-1111-4111-8111-111111111111";
const icon = `public-asset:${id}|1|${encodeURIComponent("https://untrusted.example/tracker.png")}`;
afterEach(() => vi.unstubAllGlobals());
it("loads only selected-API PNG bytes and returns an inline image", async () => {
  const fetcher = vi.fn(async () => new Response(new Uint8Array([137,80,78,71]), { headers: { "content-type": "image/png" } }));
  vi.stubGlobal("fetch", fetcher);
  expect(await loadInlineIcon("https://api.example", icon)).toBe("data:image/png;base64,iVBORw==");
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://api.example/api/public-assets/${id}/revisions/1/content`, expect.objectContaining({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }));
});
it("does not load arbitrary URLs or render unsupported image types", async () => {
  const fetcher = vi.fn(async () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }));
  vi.stubGlobal("fetch", fetcher);
  expect(await loadInlineIcon("https://api.example", "https://untrusted.example/tracker.png")).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  expect(await loadInlineIcon("https://api.example", icon)).toBeUndefined();
});

it("resolves capture catalog IDs through the selected API before loading PNG bytes", async () => {
  const fetcher = vi.fn(async (url: string) => url.endsWith('/by-ids')
    ? Response.json({ items: [{ id, revision: 7, url: 'https://untrusted.example/tracker.png' }] })
    : new Response(new Uint8Array([137,80,78,71]), { headers: { 'content-type': 'image/png' } }));
  vi.stubGlobal('fetch', fetcher);
  expect(await loadInlineIcon('https://api.example', `public-asset:${id}`)).toBe('data:image/png;base64,iVBORw==');
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://api.example/api/public-assets/by-ids',
    `https://api.example/api/public-assets/${id}/revisions/7/content`,
  ]);
});

it.each([Response.json({ items: [] }), new Response(null, { status: 503 })])(
  "falls back without requesting image bytes when the catalog asset is unavailable", async response => {
    const fetcher = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetcher);
    expect(await loadInlineIcon('https://api.example', `public-asset:${id}`)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
