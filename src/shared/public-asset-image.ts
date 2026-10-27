const MAXIMUM_IMAGE_BYTES = 1024 * 1024;

export async function loadPublicAssetPng(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, {
    signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
  });
  if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "image/png" || !response.body) {
    await response.body?.cancel();
    throw new Error("Public icon unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAXIMUM_IMAGE_BYTES) throw new Error("Public icon exceeds image budget");
      chunks.push(new Uint8Array(value));
    }
    return new Blob(chunks, { type: "image/png" });
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
