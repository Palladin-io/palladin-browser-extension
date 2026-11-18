import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Synthetic CaptureLab specimen. Direct isolated DOM adapters, no real accounts.
const html = await readFile('tests/fixtures/forms/capturelab-card/page.html', 'utf8');
const css = await readFile('tests/fixtures/forms/capturelab-card/page.css', 'utf8');
const bundle = await build({ stdin: { contents: `export { loginTargetFor, performFill, performLoginTargetFill } from './src/content/isolated/fill'; export { detectSecretCandidates } from './src/content/isolated/secret-detection';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'cardRegression', platform: 'browser' });
const browser = await chromium.launch({headless:true});
const failures = [];
try {
 const page=await browser.newPage();
 await page.route('https://capture.example.test/**',route=>route.fulfill({contentType:'text/html',body:`<style>${css}</style>${html}`}));
 await page.goto('https://capture.example.test/card');
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 const automatic = await page.evaluate(() => {
  const target=[...document.querySelectorAll('input')].map(cardRegression.loginTargetFor).find(Boolean);
  if(target) cardRegression.performLoginTargetFill(target,[{kind:'password',value:'SyntheticPortalPassword!'}],'automatic');
  return {targets:target?1:0,empty:document.querySelector('[name=cvc]').value===''};
 });
 try { assert.deepEqual(automatic,{targets:0,empty:true}); } catch { failures.push('automatic Credential fill writes into payment CVC'); }
 const manual = await page.evaluate(() => {document.querySelector('[name=cvc]').value=''; return cardRegression.performFill(document,[{kind:'password',value:'SyntheticPortalPassword!'}]).ok;});
 if(manual) failures.push('explicit Credential fill accepts payment CVC');
 for(const cvc of ['123','1234']) {
  for(const [name,value] of Object.entries({cardholder:'Synthetic Cardholder',month:'12',year:'2031',cvc,number:'4242424242424242'})) await page.locator(`[name=${name}]`).fill(value);
  await page.locator('[name=number]').blur();
  const matches=await page.evaluate(cvc=>{const candidates=cardRegression.detectSecretCandidates(document); return candidates.length===1&&candidates[0].kind==='card'&&candidates[0].cvv===cvc},cvc);
  if(!matches) failures.push(`masked ${cvc.length}-digit CVC missing from capture after input/blur`);
 }
 assert.deepEqual(failures,[]);
 console.log('PASS CaptureLab card: automatic/manual Credential rejection, masked 3/4-digit capture after Chromium input/blur');
} finally { await browser.close(); }
