// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { SecretCaptureNotice } from './secret-notice';

it('keeps notice closed, value-free, input-free and rejects a synthetic consent click', () => {
  let root!: ShadowRoot;
  const attach = Element.prototype.attachShadow;
  const spy = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { root = attach.call(this, init); return root; });
  let actions = 0;
  const notice = new SecretCaptureNotice(document, async () => { actions++; });
  notice.show(false);
  const host = document.querySelector('palladin-capture')!;
  expect(host.shadowRoot).toBeNull(); expect(root.querySelector('input,textarea,select')).toBeNull();
  expect(root.textContent).toContain('A key or payment card is ready to review');
  root.querySelector('button')!.click(); expect(actions).toBe(0);
  notice.show(true); expect(root.textContent).toContain('Nothing was retained');
  notice.stop(); expect(document.querySelector('palladin-capture')).toBeNull(); spy.mockRestore();
});
