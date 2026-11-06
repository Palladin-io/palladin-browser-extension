import brandLogoUrl from '../../../icons/logo-source.png?inline';

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

export const CAPTURE_NOTICE_STYLES = `
  :host { color-scheme:light; --cv-primary:#E54645; --cv-primary-hover:#d43e3e;
    --cv-bg:#f3f5f8; --cv-surface:#fff; --cv-wash:#f7f8fa; --cv-t1:#0c0e12; --cv-t2:#5a6478;
    --cv-border:rgba(12,14,18,.13); --cv-subtle:rgba(12,14,18,.05); }
  :host([data-theme="dark"]) { color-scheme:dark; --cv-bg:#15171b; --cv-surface:#191c20; --cv-wash:#22262c;
    --cv-t1:#e8eaed; --cv-t2:#b8c5d4; --cv-border:rgba(232,234,237,.15); --cv-subtle:rgba(232,234,237,.07); }
  * { box-sizing:border-box; }
  .panel { overflow:hidden; border:1px solid var(--cv-border); border-radius:12px; background:var(--cv-surface);
    color:var(--cv-t1); box-shadow:0 12px 32px rgba(0,0,0,.16); font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; animation:notice-appear 180ms ease-out; }
  .header { display:flex; align-items:center; justify-content:space-between; gap:12px; height:68px; min-height:68px; padding:16px 20px;
    border-bottom:1px solid var(--cv-border); background:linear-gradient(115deg,var(--cv-wash),var(--cv-surface) 80%); }
  .notice-brand { display:flex; align-items:center; gap:9px; font-size:14px; font-weight:700; }
  .notice-brand img { width:28px; height:28px; object-fit:contain; }
  .notice-brand strong { font:inherit; }
  .notice-brand strong span { color:var(--cv-primary); }
  .notice-body { padding:16px 20px; }
  .notice-title { margin:0; font-size:15px; font-weight:600; }
  .site { margin-top:5px; color:var(--cv-t2); font-size:12px; overflow-wrap:anywhere; }
  button { font:inherit; font-size:12px; font-weight:600; text-transform:none; letter-spacing:normal; cursor:pointer; border:1px solid transparent; border-radius:6px; }
  button:focus-visible { outline:2px solid var(--cv-primary); outline-offset:2px; }
  button:disabled { opacity:.6; cursor:wait; }
  .close { background:transparent; color:var(--cv-t2); font-size:20px; width:28px; height:28px; padding:0; }
  .primary { min-height:36px; padding:7px 13px; background:var(--cv-primary); color:#fff; overflow-wrap:anywhere; }
  .primary:hover { background:var(--cv-primary-hover); }
  .secondary { min-height:36px; padding:7px 13px; background:var(--cv-surface); color:var(--cv-t1); border-color:var(--cv-border); }
  .secondary:hover,.close:hover,.site-mute:hover { background:var(--cv-subtle); }
  .footer { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px; padding:12px 20px; border-top:1px solid var(--cv-border); }
  .footer button { width:100%; min-width:0; }
  .site-mute { display:block; padding:4px 0; margin-top:10px; background:transparent; color:var(--cv-t2); font-weight:400; }
  .choices { display:flex; flex-direction:column; gap:6px; max-height:220px; overflow:auto; }
  .choice { padding:9px 10px; min-height:36px; text-align:left; background:var(--cv-surface); color:var(--cv-t1); border:1px solid var(--cv-border); overflow-wrap:anywhere; }
  .choice-vault { display:block; margin-top:3px; color:var(--cv-t2); font-size:12px; }
  .note { font-size:12px; color:var(--cv-t2); margin:8px 0; }
  .error { color:var(--cv-primary); }
  @keyframes notice-appear { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
  @media(prefers-reduced-motion:reduce) { .panel { animation:none; } }
`;
