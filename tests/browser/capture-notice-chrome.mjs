import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Synthetic rendering acceptance: production notice renderers, no extension API or real site data.
const server = await createServer({ configFile: false, root: process.cwd(), resolve: {
  alias: { '@shared': path.resolve('src/shared') },
}, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'notice-fixture', configureServer(server) {
  server.middlewares.use('/notice-fixture', (_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><body><script type="module">window.fixtureReady = true;</script></body></html>');
  });
} } ] });
await server.listen();
await mkdir('test-results/capture-notice-chrome', { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, colorScheme: theme, reducedMotion: 'reduce' });
    await page.goto(`${server.resolvedUrls.local[0]}notice-fixture`);
    for (const kind of ['credential', 'secret', 'totp', 'federated']) {
      const result = await page.evaluate(async ({ kind, theme }) => {
        window.notice?.stop();
        const attach = Element.prototype.attachShadow;
        let root;
        Element.prototype.attachShadow = function(options) { root = attach.call(this, options); return root; };
        const preferences = { theme, language: 'en' };
        window.chrome = { storage: { onChanged: { addListener() {}, removeListener() {} }, local: { async get() { return { 'palladin.ui.preferences': preferences }; } } }, i18n: { getUILanguage: () => 'en' } };
        try {
          if (kind === 'credential') {
            const { CredentialCaptureToast } = await import('/src/content/isolated/credential-toast.ts');
            window.notice = new CredentialCaptureToast(document, 'synthetic-document', async () => ({ status: 'accepted' }));
            window.notice.setAppearance('en', theme);
            window.notice.show({ status: 'prompt', prompt: { id: 'synthetic-prompt', site: 'example.test', state: 'ready', targets: [], defaultTargetId: null } });
          } else if (kind === 'federated') {
            const { FederatedSignInSurface } = await import('/src/content/isolated/federated-signin.ts');
            window.notice = new FederatedSignInSurface(document, 'synthetic-document', async () => ({ status: 'accepted' }), () => 'manual');
            window.notice.setAppearance('en', theme);
            window.notice.showResult({ status: 'prompt', prompt: { id: 'synthetic-prompt', site: 'example.test', state: 'ready', provider: 'google' } });
          } else {
            const { SecretCaptureNotice } = await import('/src/content/isolated/secret-notice.ts');
            window.notice = new SecretCaptureNotice(document, async () => {}, kind);
            window.notice.show(false);
          }
          await new Promise(resolve => requestAnimationFrame(resolve));
          const host = document.querySelector('palladin-capture');
          const header = root.querySelector('.header');
          const footer = root.querySelector('.footer');
          const buttons = [...footer.querySelectorAll('button')];
          const logo = root.querySelector('.notice-brand img');
          await logo.decode();
          return { brand: root.querySelector('.notice-brand').textContent, logoWidth: logo.naturalWidth,
            headerHeight: header.getBoundingClientRect().height, gradient: getComputedStyle(header).backgroundImage,
            footerBorder: getComputedStyle(footer).borderTopWidth,
            buttons: buttons.map(button => ({ label: button.textContent, width: button.getBoundingClientRect().width })),
            animation: getComputedStyle(root.querySelector('.panel')).animationName,
            closed: host.shadowRoot === null, theme: host.dataset.theme,
          };
        } finally { Element.prototype.attachShadow = attach; }
      }, { kind, theme });
      assert.equal(result.brand, 'Palladin.io');
      assert(result.logoWidth > 0, 'real packaged shield loads');
      assert.equal(result.headerHeight, 68);
      assert(result.gradient.startsWith('linear-gradient(115deg,'));
      assert.equal(result.footerBorder, '1px');
      assert.deepEqual(result.buttons.map(button => button.label), ['Dismiss', 'Review']);
      assert.equal(result.buttons[0].width, result.buttons[1].width);
      assert.equal(result.animation, 'none');
      assert.equal(result.closed, true);
      assert.equal(result.theme, theme);
      await page.screenshot({ path: `test-results/capture-notice-chrome/${theme}-${kind}.png` });
      console.log(`PASS ${theme} ${kind}: brand, neutral gradient, fixed header, equal actions, closed root, reduced motion`);
    }
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
