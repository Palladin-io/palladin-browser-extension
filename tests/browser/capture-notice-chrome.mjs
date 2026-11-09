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
  for (const language of ['en', 'pl']) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, colorScheme: theme, reducedMotion: 'reduce' });
    await page.goto(`${server.resolvedUrls.local[0]}notice-fixture`);
    for (const kind of ['credential', 'card', 'key', 'totp', 'federated']) {
      const result = await page.evaluate(async ({ kind, theme, language }) => {
        window.notice?.stop();
        window.noticeActions = [];
        const attach = Element.prototype.attachShadow;
        let root;
        Element.prototype.attachShadow = function(options) { root = attach.call(this, options); return root; };
        const preferences = { theme, language };
        const identity = {kind: ['credential','federated'].includes(kind) ? 'credential' : kind,site:'example.test',name:kind==='card'?'Visa':'Example',detail:kind==='card'?'•••• 4242':kind==='key'?'':'demo@example.test',...(kind==='card'?{cardBrand:'Visa'}:{})};
        window.noticeIdentity = identity;
        window.chrome = { storage: { onChanged: { addListener() {}, removeListener() {} }, local: { async get() { return { 'palladin.ui.preferences': preferences }; } } }, i18n: { getUILanguage: () => language } };
        try {
          if (kind === 'credential') {
            const { CredentialCaptureToast } = await import('/src/content/isolated/credential-toast.ts');
            window.notice = new CredentialCaptureToast(document, 'synthetic-document', async command => { window.noticeActions.push(command.type); return {status:'accepted'}; });
            window.notice.setAppearance(language, theme);
            window.notice.show({ status: 'prompt', prompt: { id: 'synthetic-prompt', site: 'example.test', state: 'ready', targets: [], defaultTargetId: null, notice:identity } });
          } else if (kind === 'federated') {
            const { FederatedSignInSurface } = await import('/src/content/isolated/federated-signin.ts');
            window.notice = new FederatedSignInSurface(document, 'synthetic-document', async command => { window.noticeActions.push(command.type); return {status:'accepted'}; }, () => 'manual');
            window.notice.setAppearance(language, theme);
            window.notice.showResult({ status: 'prompt', prompt: { id: 'synthetic-prompt', site: 'example.test', state: 'ready', provider: 'google', notice:identity } });
          } else {
            const { SecretCaptureNotice } = await import('/src/content/isolated/secret-notice.ts');
            window.notice = new SecretCaptureNotice(document, async type => { window.noticeActions.push(type); }, kind==='totp'?'totp':'secret');
            window.notice.show(false, identity);
          }
          await new Promise(resolve => requestAnimationFrame(resolve));
          const host = document.querySelector('palladin-capture');
          const header = root.querySelector('.header');
          const footer = root.querySelector('.footer');
          const buttons = [...footer.querySelectorAll('button.secondary:not(.dismiss-options), button.primary')];
          const logo = root.querySelector('.notice-brand img');
          window.noticeShadow = root;
          const split = root.querySelector('.dismiss-split');
          {
            if (!split || root.querySelector('.notice-body .site-mute')) throw new Error('site preference must be inside split Dismiss');
          }
          await logo.decode();
          return { brand: root.querySelector('.notice-brand').textContent, logoWidth: logo.naturalWidth,
            title:root.querySelector('.notice-title')?.textContent, identity:root.querySelector('.notice-identity')?.textContent,
            body:root.querySelector('.notice-body, .body')?.textContent,
            headerHeight: header.getBoundingClientRect().height, gradient: getComputedStyle(header).backgroundImage,
            footerBorder: getComputedStyle(footer).borderTopWidth, primary: getComputedStyle(buttons[1]).backgroundColor,
            buttons: buttons.map(button => ({ label: button.textContent, width: (button.closest('.dismiss-split') ?? button).getBoundingClientRect().width })),
            animation: getComputedStyle(root.querySelector('.panel')).animationName,
            closed: host.shadowRoot === null, theme: host.dataset.theme,
          };
        } finally { Element.prototype.attachShadow = attach; }
      }, { kind, theme, language });
      assert.equal(result.brand, 'Palladin.io');
      assert.equal(result.title, (language==='pl'?{credential:'Zapisz login',card:'Zapisz kartę płatniczą',key:'Zapisz klucz API',totp:'Zapisz uwierzytelniacz',federated:'Zapamiętaj metodę logowania'}:{credential:'Save login',card:'Save payment card',key:'Save API key',totp:'Save authenticator',federated:'Remember sign-in method'})[kind]);
      assert.equal(result.logoWidth, 128, 'exact approved prototype shield derivative loads');
      assert.equal(result.headerHeight, 68);
      assert(result.gradient.startsWith('linear-gradient(115deg,'));
      assert.equal(result.footerBorder, '1px');
      assert.equal(result.primary, 'rgb(212, 62, 62)', 'approved primary color');
      assert.deepEqual(result.buttons.map(button => button.label), language==='pl'?['Odrzuć', 'Sprawdź']:['Dismiss', 'Review']);
      assert.equal(result.buttons[0].width, result.buttons[1].width);
      assert.equal(result.animation, 'none');
      assert.equal(result.closed, true);
      assert.equal(result.theme, theme);
      {
        if (kind === 'federated') await page.waitForTimeout(550);
        const toggle = await page.evaluate(() => {const rect=window.noticeShadow.querySelector('.dismiss-options').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};});
        await page.mouse.click(toggle.x,toggle.y);
        if (['card','key','totp'].includes(kind)) await page.evaluate(() => window.notice.show(false,{...window.noticeIdentity}));
        assert.equal(await page.evaluate(() => window.noticeShadow.querySelector('.site-preference').hidden), false, 'pointer click on chevron opens preference');
        await page.keyboard.press('Escape');
        await page.evaluate(() => { window.noticeShadow.querySelector('.dismiss-options').focus(); });
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => window.noticeShadow.querySelector('.dismiss-options').getAttribute('aria-expanded')), 'true');
        assert.equal(await page.evaluate(() => window.noticeShadow.querySelector('.site-preference').hidden), false);
        await page.screenshot({ path: `test-results/capture-notice-chrome/${language}-${theme}-dismiss-options.png` });
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => window.noticeShadow.querySelector('.site-preference').hidden), true);
        assert.deepEqual(await page.evaluate(() => window.noticeActions), [], 'opening and closing options does not dismiss or mute');
        await page.keyboard.press('Enter');
        const mute = await page.evaluate(() => {const rect=window.noticeShadow.querySelector('.site-mute').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};});
        await page.mouse.click(mute.x,mute.y);
        await page.waitForFunction(() => window.noticeActions.includes('mute'));
        assert.deepEqual(await page.evaluate(() => window.noticeActions), ['mute']);
      }
      await page.screenshot({ path: `test-results/capture-notice-chrome/${language}-${theme}-${kind}.png` });
      console.log(`PASS ${theme} ${kind}: brand, neutral gradient, fixed header, equal actions, closed root, reduced motion`);
    }
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
