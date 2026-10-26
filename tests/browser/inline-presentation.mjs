import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = process.cwd();
// Synthetic layout fixture: checks the actual chooser at desktop and narrow widths.
// This is not a live Allegro acceptance test.
const server = await createServer({ root, define: { __PALLADIN_TARGET__: JSON.stringify('chromium'), __PALLADIN_CHANNEL__: JSON.stringify('production') }, appType: 'custom', configFile: false, resolve: { alias: { '@shared': root + '/src/shared' } }, server: { host: '127.0.0.1', port: 5299, strictPort: true } });
const html = `<html><style>body{margin:0;padding:36px 28px;background:#f5f6f8;font:14px system-ui}h1{font-size:22px;margin-bottom:26px}input{box-sizing:border-box;width:100%;height:44px;padding:10px;border:1px solid #ccd0d8;border-radius:8px;margin-bottom:12px}</style><h1>Workspace</h1><form><input autocomplete=username value=synthetic@example.test><input type=password></form><script type=module>
window.__PALLADIN_TARGET__='chromium';window.__PALLADIN_CHANNEL__='production';
const theme=new URLSearchParams(location.search).get('theme')||'light';
window.chrome={runtime:{getURL:p=>p},storage:{local:{get:async()=>({'palladin.ui.preferences':{theme,language:'pl'}})}},i18n:{getUILanguage:()=> 'pl'}};
const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(init){return attach.call(this,{...init,mode:'open'})};
const {startInlineAutofill}=await import('/src/content/isolated/inline-autofill.ts');
startInlineAutofill(document,'a'.repeat(32),async()=>({ok:true,kind:'suggestions',status:'ready',entries:[1,2].map(i=>({vaultId:'vault',entryId:'technical-id-'+i,name:'Konto zakupowe',username:'synthetic@example.test',vaultName:'Osobisty',urlDomain:'example.test',updatedAt:'2026-10-17T00:00:00Z',match:'exact'}))}));window.ready=true;
</script></html>`;
server.middlewares.use((req, res, next) => { if (req.url.startsWith('/preview')) {
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
}
else
    next(); });
await server.listen();
let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 420, height: 540 }, deviceScaleFactor: 2 });
    page.on('pageerror', e => console.error(e.message));
    for (const theme of ['light', 'dark']) {
        await page.goto('http://127.0.0.1:5299/preview?theme=' + theme);
        await page.waitForFunction(() => window.ready);
        await page.locator('.launcher').click();
        await page.locator('.option').first().waitFor();
        if ((await page.locator('.list').innerText()).includes('technical-id'))
            throw Error('Technical ID exposed');
        const button = await page.locator('.submit-login').first().boundingBox(), option = await page.locator('.option').first().boundingBox();
        const panel = await page.locator('.panel').boundingBox(), field = await page.locator('input').first().boundingBox();
        if (panel.x < field.x - 1 || panel.x + panel.width > field.x + field.width + 1)
            throw Error('Panel outside field');
        if (button.x + button.width > panel.x + panel.width - 8)
            throw Error('Button overflow');
        if (button.y > option.y + option.height)
            throw Error('Button outside row');
        if (await page.locator('.list').evaluate(el => el.scrollWidth > el.clientWidth))
            throw Error('Horizontal overflow');
        if ((await page.locator('.option strong').first().innerText()).includes('(1)'))
            throw Error('Ordinal');
        await page.screenshot({ path: '/tmp/palladin-inline-buttons-' + theme + '.png' });
        await page.setViewportSize({ width: 320, height: 540 });
    }
    console.log('Light/dark actual UI verified: names, no IDs, compact rows, aligned panel, no overflow.');
}
finally {
    await browser?.close();
    await server.close();
}
