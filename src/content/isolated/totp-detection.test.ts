// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { detectTotpUris, parseCapturedTotp } from './totp-detection';

const uri = 'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example';
afterEach(() => document.body.replaceChildren());
describe('TOTP capture detection', () => {
  it('accepts a valid TOTP URI and rejects HOTP, rolling codes and oversized input', () => {
    expect(parseCapturedTotp(uri)?.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(parseCapturedTotp(uri.replace('totp/', 'hotp/'))).toBeNull();
    expect(parseCapturedTotp('123456')).toBeNull();
    expect(parseCapturedTotp(uri + 'x'.repeat(4096))).toBeNull();
    expect(parseCapturedTotp('otpauth://totp/x?secret=!')).toBeNull();
  });
  it('detects a rendered setup output but not illustrative code snippets', () => {
    document.body.innerHTML = `<output>${uri}</output><pre><code>${uri}</code></pre>`;
    expect(detectTotpUris(document)).toEqual([uri]);
    document.querySelector('output')!.remove();
    expect(detectTotpUris(document)).toEqual([]);
  });
  it('finds visible setup links but skips hidden elements and input values', () => {
    document.body.innerHTML = `<a href="${uri}">Set up</a><a hidden href="${uri}">Hidden</a><input value="${uri}">`;
    expect(detectTotpUris(document)).toEqual([uri]);
  });
});

it('decodes rendered canvas pixels locally and ignores ordinary QR values', async () => {
  const { scanTotpQr } = await import('./totp-detection');
  document.body.innerHTML = '<canvas width="64" height="64"></canvas>';
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4) }) })) as unknown as typeof getContext;
  try {
    expect(scanTotpQr(document, () => uri)).toEqual([uri]);
    expect(scanTotpQr(document, () => 'https://example.com')).toEqual([]);
  } finally { HTMLCanvasElement.prototype.getContext = getContext; }
});
