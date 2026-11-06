// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { SecretCaptureNotice } from './secret-notice';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.querySelectorAll('palladin-capture').forEach(host => host.remove()); });

it('keeps notice closed, value-free, input-free and rejects a synthetic consent click', () => {
  let root!: ShadowRoot;
  const attach = Element.prototype.attachShadow;
  const spy = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { root = attach.call(this, init); return root; });
  let actions = 0;
  const notice = new SecretCaptureNotice(document, async () => { actions++; });
  notice.show(false);
  const host = document.querySelector('palladin-capture')!;
  expect((host as HTMLElement).style.top).toBe('16px');
  expect((host as HTMLElement).style.right).toBe('16px');
  expect(root.querySelector('.notice-brand')?.textContent).toBe('Palladin.io');
  expect(root.querySelector('.notice-brand img')).not.toBeNull();
  expect(root.querySelector('.notice-footer')?.querySelectorAll('button')).toHaveLength(2);
  expect(host.shadowRoot).toBeNull(); expect(root.querySelector('input,textarea,select')).toBeNull();
  expect(root.textContent).toContain('A key or payment card is ready to review');
  root.querySelector('button')!.click(); expect(actions).toBe(0);
  notice.show(true); expect(root.textContent).toContain('Nothing was retained');
  notice.stop(); expect(document.querySelector('palladin-capture')).toBeNull(); spy.mockRestore();
});

it.each(['en', 'pl'])('does not tell the %s user to leave TOTP review before an opening failure', locale => {
  vi.stubGlobal('chrome', { i18n: { getUILanguage: () => locale } });
  let root!: ShadowRoot; const attach = Element.prototype.attachShadow;
  const spy = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { root = attach.call(this, init); return root; });
  const notice = new SecretCaptureNotice(document, async () => {}, 'totp');
  notice.show(false);
  expect(root.textContent).not.toContain(locale === 'pl' ? 'Otwórz menu rozszerzeń przeglądarki' : 'Open your browser’s Extensions menu and click Palladin to continue.');
  expect(document.querySelector('palladin-capture')).toBeInTheDocument();
  notice.stop(); spy.mockRestore(); vi.unstubAllGlobals();
});

it('renders the captured card identity and network image without card secrets',()=>{
  let root!:ShadowRoot;const attach=Element.prototype.attachShadow;
  vi.spyOn(Element.prototype,'attachShadow').mockImplementation(function(this:Element,init){root=attach.call(this,init);return root;});
  const notice=new SecretCaptureNotice(document,async()=>{});
  notice.show(false,{kind:'card',site:'pay.example.test',name:'Visa',detail:'•••• 4242',cardBrand:'Visa'});
  expect(root.querySelector('.notice-title')).toHaveTextContent('Save payment card');
  expect(root.querySelector('.site')).toHaveTextContent('Captured on pay.example.test');
  expect(root.querySelector('.notice-summary strong')).toHaveTextContent('Visa');
  expect(root.querySelector('.notice-summary img')).not.toBeNull();
  expect(root.querySelector('.notice-summary small')).toHaveTextContent('•••• 4242');
  expect(root.querySelector('input')).toBeNull();
  expect(root.querySelector('.header button')).toHaveAttribute('aria-label','Dismiss save suggestion');
  notice.show(true);expect(root.querySelector('.notice-summary')).toBeNull();notice.stop();
});
