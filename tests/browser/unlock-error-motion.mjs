import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const server=await createServer({configFile:false,root:process.cwd(),optimizeDeps:{include:['react','react-dom/client','react/jsx-dev-runtime']},resolve:{alias:{'@shared':path.resolve('src/shared')}},server:{host:'127.0.0.1',port:0}});
await server.listen();
const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:400,height:600}});
 page.on('pageerror',e=>console.error(e.message));
 await page.route('**/unlock-fixture',route=>route.fulfill({contentType:'text/html',body:`<html data-extension-surface="popup"><body><div id="root"></div><script type="module">
 import React from '/node_modules/.vite/deps/react.js'; window.React=React;
 import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js'; const {createRoot}=ReactDOM;
 import {UnlockScreen} from '/src/popup/screens/UnlockScreen.tsx';
 import {PopupSessionError} from '/src/popup/session/errors.ts';
 import {Header} from '/src/popup/components/Header.tsx';
 import '/src/popup/popup.css'; import '/src/popup/redesign.css';
 createRoot(document.getElementById('root')).render(React.createElement('div',{className:'popup','data-phase':'locked'},React.createElement(Header,{authBrand:true}),React.createElement(UnlockScreen,{biometricAvailable:false,onSignOut:async()=>{},onUnlock:async()=>{throw new PopupSessionError('incorrect-password');}})));
 window.sizes=[];const sample=()=>{const panel=document.querySelector('.auth-form-panel');window.sizes.push({height:document.body.getBoundingClientRect().height,scroll:panel?panel.scrollHeight-panel.clientHeight:0,overflow:panel?getComputedStyle(panel).overflowY:''});requestAnimationFrame(sample)};sample();
 </script></body></html>`}));
 for(const reduced of [false,true]) {
  await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});
  await page.goto(server.resolvedUrls.local[0]+'unlock-fixture');
  await page.locator('input').fill('synthetic-wrong-password');
  await page.waitForTimeout(300);
  const before=await page.locator('body').evaluate(n=>n.getBoundingClientRect().height);
  await page.evaluate(()=>window.sizes=[]);
  await page.getByRole('button',{name:'Unlock',exact:true}).click();
  await page.getByRole('alert').waitFor();
  await page.waitForTimeout(450);
  const samples=await page.evaluate(()=>window.sizes);
  console.log({reduced,before,final:samples.at(-1),root:await page.locator('html').evaluate(n=>n.style.getPropertyValue('--unlock-feedback-height'))});
  assert(samples.at(-1).height>before+10,'error expands popup instead of scrolling its fixed-height form');
  assert(samples.every(s=>s.scroll<=1||!['auto','scroll'].includes(s.overflow)),'no scrollbar flashes during expansion');
  assert(samples.at(-1).scroll<=1,'complete form fits after expansion');
  if(!reduced) assert(samples.some(s=>s.height>before+1&&s.height<samples.at(-1).height-1),'height changes smoothly through intermediate frames');
 }
 console.log('PASS unlock error expands smoothly without scrollbar, including reduced motion');
} finally {await browser.close();await server.close();}
