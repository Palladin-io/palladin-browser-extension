import type { CaptureNoticeIdentity } from '@shared/messaging/capture-notice';
import type { SignInProvider } from '@shared/signin/providers';
import visa from './assets/visa.svg?inline';
import mastercard from './assets/mastercard.svg?inline';
import amex from './assets/amex.svg?inline';
import google from '../../popup/assets/sign-in-providers/google.svg?inline';
import apple from '../../popup/assets/sign-in-providers/apple.svg?inline';
import microsoft from '../../popup/assets/sign-in-providers/microsoft.svg?inline';
import github from '../../popup/assets/sign-in-providers/github.svg?inline';
import facebook from '../../popup/assets/sign-in-providers/facebook.svg?inline';
import brandLogoUrl from '../../../icons/icon-128.png?inline';

export function captureNoticeHeader(doc: Document): HTMLDivElement {
  const header = doc.createElement('div');
  header.className = 'header';
  const brand = doc.createElement('div');
  brand.className = 'notice-brand';
  const icon = doc.createElement('img');
  icon.src = brandLogoUrl;
  icon.alt = '';
  const wordmark = doc.createElement('strong');
  wordmark.append('Palladin');
  const domain = doc.createElement('span');
  domain.textContent = '.io';
  wordmark.append(domain);
  brand.append(icon, wordmark);
  header.append(brand);
  return header;
}

export function captureNoticeCloseIcon(doc: Document): SVGSVGElement {
  const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 6l12 12M18 6 6 18');
  icon.append(path);
  return icon;
}

export const CAPTURE_NOTICE_STYLES = `
  :host { color-scheme:light; --cv-primary:#D43E3E; --cv-primary-hover:color-mix(in srgb,var(--cv-primary) 90%,black);
    --cv-bg:#f3f5f8; --cv-surface:#fff; --cv-wash:#f7f8fa; --cv-t1:#0c0e12; --cv-t2:#5a6478;
    --cv-border:rgba(12,14,18,.13); --cv-subtle:rgba(12,14,18,.05); }
  :host([data-theme="dark"]) { color-scheme:dark; --cv-bg:#15171b; --cv-surface:#191c20; --cv-wash:#22262c;
    --cv-t1:#e8eaed; --cv-t2:#b8c5d4; --cv-border:rgba(232,234,237,.15); --cv-subtle:rgba(232,234,237,.07); }
  * { box-sizing:border-box; }
  .panel { overflow:hidden; border:1px solid var(--cv-border); border-radius:10px; background:var(--cv-surface);
    color:var(--cv-t1); box-shadow:0 12px 32px rgba(0,0,0,.16); font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; animation:notice-appear 180ms ease-out; }
  .header { display:flex; align-items:center; justify-content:space-between; gap:12px; height:68px; min-height:68px; padding:16px 20px;
    border-bottom:1px solid var(--cv-border); background:linear-gradient(115deg,var(--cv-wash),var(--cv-surface) 80%); }
  .notice-brand { display:flex; align-items:center; gap:16px; font-size:16px; font-weight:700; }
  .notice-brand img { width:28px; height:28px; object-fit:contain; }
  .notice-brand strong { font:inherit; }
  .notice-brand strong span { color:var(--cv-primary); }
  .notice-body { padding:16px 20px; }
  .notice-title { margin:0; font-size:18px; font-weight:600; }
  .site { margin-top:5px; color:var(--cv-t2); font-size:12px; overflow-wrap:anywhere; }
  button { font:inherit; font-size:12px; font-weight:600; text-transform:none; letter-spacing:normal; cursor:pointer; border:1px solid transparent; border-radius:6px; }
  button:focus-visible { outline:2px solid var(--cv-primary); outline-offset:2px; }
  button:disabled { opacity:.6; cursor:wait; }
  .close { background:transparent; color:var(--cv-t2); width:28px; height:28px; padding:0; display:grid; place-items:center; }
  .close svg { display:block; width:16px; height:16px; pointer-events:none; }
  .primary { min-height:36px; padding:7px 13px; background:var(--cv-primary); color:#fff; overflow-wrap:anywhere; }
  .primary:hover { background:var(--cv-primary-hover); }
  .secondary { min-height:36px; padding:7px 13px; background:var(--cv-surface); color:var(--cv-t1); border-color:var(--cv-border); }
  .secondary:hover,.close:hover,.site-mute:hover { background:var(--cv-subtle); }
  .footer { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px; padding:12px 20px; border-top:1px solid var(--cv-border); }
  .footer button { width:100%; min-width:0; }
  .notice-summary { display:flex;align-items:center;gap:10px;padding:12px;border:1px solid var(--cv-border);border-radius:8px;margin-top:16px; }
  .notice-identity-icon { display:grid;place-items:center;flex:0 0 36px;width:36px;height:32px;border:1px solid var(--cv-border);border-radius:6px;color:var(--cv-t2); }
  .notice-identity-icon img { max-width:28px;max-height:22px;object-fit:contain; }
  .notice-identity-icon svg { width:20px;height:20px; }
  .notice-identity-text { min-width:0;overflow-wrap:anywhere; }
  .notice-identity-text strong { display:block;font-size:13px;font-weight:600; }
  .notice-identity-text small { display:block;font-size:11px;color:var(--cv-t2); }
  .notice-provider { margin-left:auto; }
  .dismiss-split { position:relative; display:flex; min-width:0; }
  .dismiss-split > .secondary:first-child { border-radius:6px 0 0 6px; border-right:0; }
  .dismiss-split > .dismiss-options { flex:0 0 32px; width:32px; padding:0; border-radius:0 6px 6px 0; display:grid; place-items:center; }
  .dismiss-options svg, .site-mute small { pointer-events:none; }
  .dismiss-options svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .site-preference { position:absolute; z-index:1; bottom:calc(100% + 8px); left:0; width: min(300px, calc(100vw - 76px)); padding:4px; background:var(--cv-surface); border:1px solid var(--cv-border); border-radius:8px; box-shadow:0 8px 24px #0002; }
  .site-mute { display:block; padding:10px; background:transparent; color:var(--cv-t1); text-align:left; font-weight:500; }
  .site-mute small { display:block; margin-top:3px; font-size:11px; color:var(--cv-t2); font-weight:400; overflow-wrap:anywhere; }
  .choices { display:flex; flex-direction:column; gap:6px; max-height:220px; overflow:auto; }
  .choice { padding:9px 10px; min-height:36px; text-align:left; background:var(--cv-surface); color:var(--cv-t1); border:1px solid var(--cv-border); overflow-wrap:anywhere; }
  .choice-vault { display:block; margin-top:3px; color:var(--cv-t2); font-size:12px; }
  .note { font-size:12px; color:var(--cv-t2); margin:8px 0; }
  .error { color:var(--cv-primary); }
  @keyframes notice-appear { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
  @media(prefers-reduced-motion:reduce) { .panel { animation:none; } }
`;

export function captureNoticeIdentity(doc: Document, identity: CaptureNoticeIdentity, detail: string, provider?: SignInProvider): HTMLDivElement {
  const summary=doc.createElement('div'); summary.className='notice-summary';
  const icon=doc.createElement('span'); icon.className='notice-identity-icon';
  const brand=identity.cardBrand ? {Visa:visa,Mastercard:mastercard,'American Express':amex}[identity.cardBrand] : undefined;
  const source=brand ?? identity.iconDataUrl;
  if(source) { const img=doc.createElement('img');img.src=source;img.alt='';icon.append(img); }
  else {
    const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.5');svg.setAttribute('aria-hidden','true');
    const path=doc.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d',identity.kind==='card'?'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM2 10h20M5 15h5':identity.kind==='totp'?'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6ZM8 12l3 3 5-6':'M10 11a4 4 0 1 0-6-6 4 4 0 0 0 6 6Zm0 0 10 10m-4-4 2-2m-5-1 2-2');
    svg.append(path);icon.append(svg);
  }
  const text=doc.createElement('span');text.className='notice-identity-text';
  const name=doc.createElement('strong');name.textContent=identity.name;text.append(name);
  if(detail){const secondary=doc.createElement('small');secondary.textContent=detail;text.append(secondary);}
  summary.append(icon,text);
  if(provider){const frame=doc.createElement('span');frame.className='notice-identity-icon notice-provider';const img=doc.createElement('img');img.src={google,apple,microsoft,github,facebook}[provider];img.alt=provider;frame.append(img);summary.append(frame);}
  return summary;
}
