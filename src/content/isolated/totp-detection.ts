import jsQR from 'jsqr';
import { parseCapturedTotp } from '@shared/totp-capture';
export { parseCapturedTotp } from '@shared/totp-capture';

function visible(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false;
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  }
  return true;
}

/** Restrict passive URI detection to rendered links, never form inputs. */
export function detectTotpUris(doc: Document): string[] {
  const values = new Set<string>();
  for (const link of Array.from(doc.querySelectorAll('a[href],output')).slice(0, 1000)) {
    if (link.closest('pre,code,[contenteditable]')) continue;
    const value = link.tagName === 'A' ? link.getAttribute('href') : link.textContent?.trim();
    if (value && visible(link) && parseCapturedTotp(value)) values.add(value);
    if (values.size >= 8) break;
  }
  return [...values];
}

/** Decode only already-rendered pixels; cross-origin tainted images fail closed. */
export function scanTotpQr(doc: Document, decode: (pixels: Uint8ClampedArray, width: number, height: number) => string | null = decodeQr): string[] {
  const found = new Set<string>();
  for (const node of Array.from(doc.querySelectorAll('img,canvas')).slice(0, 32)) {
    if (!visible(node)) continue;
    const source = node as HTMLImageElement | HTMLCanvasElement;
    const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    if (!width || !height || width > 8192 || height > 8192) continue;
    const scale = Math.min(1, 1024 / Math.max(width, height));
    const canvas = doc.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) continue;
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const value = decode(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      if (value && parseCapturedTotp(value)) found.add(value);
      if (found.size >= 8) break;
    } catch { /* Tainted or inaccessible pixels cannot be read locally. */ }
  }
  return [...found];
}

function decodeQr(pixels: Uint8ClampedArray, width: number, height: number): string | null {
  return jsQR(pixels, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}
