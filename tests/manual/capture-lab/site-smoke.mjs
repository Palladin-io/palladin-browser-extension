import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({viewport:{width:1360,height:1000}});
  const requests=[];
  page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
  const headersText=await readFile(new URL('./site/_headers',import.meta.url),'utf8');
  const headers=Object.fromEntries(headersText.split('\n').slice(1).filter(s=>s.trim()).map(s=>{const i=s.indexOf(':');return [s.slice(0,i).trim(),s.slice(i+1).trim()]}));
  await page.route('https://lab.example.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    const file=pathname==='/'?'index.html':pathname.slice(1);
    assert(['index.html','lab.css','lab.js','favicon.svg','totp.png'].includes(file));
    const contentType=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'text/html';
    await route.fulfill({body:await readFile(new URL(`./site/${file}`,import.meta.url)),headers,contentType});
  });
  for(const scenario of ['login','update','card','key','generator','totp','oauth','frame']){
    await page.goto(`https://lab.example.test/?scenario=${scenario}`);
    assert.equal(await page.locator('nav a').count(),8);
    assert(await page.locator('#title').innerText());
    if(scenario==='login'){
      await page.getByLabel('Username',{exact:true}).fill('capture-user@example.test');
      await page.getByLabel('Password',{exact:true}).fill('Local-only-value!');
      await page.getByRole('button',{name:'Sign in',exact:true}).click();
      await page.getByRole('status').waitFor();
      assert.equal(await page.locator('form').count(),0);
    }
    if(scenario==='key'){
      await page.getByRole('button',{name:'Generate API key'}).click();
      assert(await page.locator('output').innerText());
    }
    if(scenario==='totp'){
      await page.getByRole('button',{name:'Reveal QR code'}).click();
      await page.locator('#qr').waitFor();
      await page.waitForFunction(()=>document.querySelector('#qr').naturalWidth>0);
      await page.getByRole('button',{name:'Reveal setup link'}).click();
      assert.equal(await page.locator('#qr').count(),0);
      assert.equal(await page.locator('a[href^="otpauth:"]').count(),1);
    }
    if(scenario==='oauth')for(const name of ['Continue with Google','Continue with GitHub'])assert(await page.getByRole('button',{name}).isDisabled());
    if(scenario==='frame')await page.frameLocator('iframe').getByLabel('Card number').waitFor();
  }
  assert(requests.every(r=>r.method==='GET'&&r.url.startsWith('https://lab.example.test/')));
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  await page.goto('https://lab.example.test/?scenario=card');
  await page.screenshot({path:'/tmp/palladin-capture-lab-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'/tmp/palladin-capture-lab-mobile.png',fullPage:true});
  console.log('PASS: eight scenarios, CSP, local-only submit, QR switch, disabled hosted OAuth, responsive layout');
}finally{await browser.close()}
