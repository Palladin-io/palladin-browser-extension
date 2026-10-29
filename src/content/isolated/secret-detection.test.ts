// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { detectSecretCandidates } from './secret-detection';
import { isSecretCandidate } from '../../shared/messaging/secret-capture';

// Fabricated alphabet/digits preserve provider-format fixtures without literal credential-shaped source.
const syntheticStripePrefix = ['sk', 'live', ''].join('_');
const syntheticStripeKey = syntheticStripePrefix + 'abcdefgh' + '1234567890123456';
beforeEach(() => {
 vi.restoreAllMocks();
 document.body.innerHTML = '';
 vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{width:100,height:20}] as unknown as DOMRectList);
 const computedStyle = window.getComputedStyle.bind(window);
 vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
  if (element.namespaceURI !== 'http://www.w3.org/1998/Math/MathML') return computedStyle(element);
  // jsdom lacks MathML style declarations; retain the fixture's inline visibility.
  const style = document.createElement('span').style;
  style.cssText = element.getAttribute('style') ?? '';
  return style;
 });
});
it('reads framework values and multilingual standard card fields independently per form', () => {
 document.body.innerHTML = '<form><input autocomplete="cc-number"><input autocomplete="cc-name" value="Jan"><input autocomplete="cc-exp" value="12/2030"></form><form><input autocomplete="cc-number" value="5555555555554444"></form>';
 (document.querySelector('input') as HTMLInputElement).value = '4111 1111 1111 1111';
 expect(detectSecretCandidates(document)).toEqual([{kind:'card',cardNumber:'4111111111111111',cardholderName:'Jan',expiryMonth:'12',expiryYear:'2030'},{kind:'card',cardNumber:'5555555555554444',cardholderName:'',expiryMonth:'',expiryYear:''}]);
});
it('supports split PAN clusters within one form', () => {
 document.body.innerHTML='<form><input maxlength="4" value="4111"><input maxlength="4" value="1111"><input maxlength="4" value="1111"><input maxlength="4" value="1111"><input placeholder="MM/YY" value="12/30"></form>';
 expect(detectSecretCandidates(document)[0]).toMatchObject({kind:'card',cardNumber:'4111111111111111'});
});
it('reads explicit API readonly and ordinary generated result output', () => {
 document.body.innerHTML=`<label>API key<input readonly value="unknown-format-secret"></label><section><h2>Generated API key</h2><code>${syntheticStripeKey}</code></section>`;
 expect(detectSecretCandidates(document)).toEqual([{kind:'key',value:'unknown-format-secret'},{kind:'key',value:syntheticStripeKey}]);
});
it('excludes documentation, arbitrary body strings, password, OTP, session and hidden values', () => {
 document.body.innerHTML=`<p>${syntheticStripeKey}</p><section><h2>API key example documentation</h2><code>${syntheticStripeKey}</code></section><input aria-label="API key" type="password" value="secret-value"><input aria-label="API key csrf" value="secret-value"><label hidden>API key<input value="secret-value"></label><input autocomplete="one-time-code" aria-label="API key" value="123456">`;
 expect(detectSecretCandidates(document)).toEqual([]);
});
it('walks open shadow roots but rejects hidden hosts', () => {
 const host=document.createElement('div'); document.body.append(host); host.attachShadow({mode:'open'}).innerHTML='<input aria-label="API key" value="opaque-credential">';
 expect(detectSecretCandidates(document)).toHaveLength(1); host.hidden=true; expect(detectSecretCandidates(document)).toEqual([]);
});
it('strictly rejects malformed oversized and extra-field boundary candidates', () => {
 expect(isSecretCandidate({kind:'key',value:'x'.repeat(4097)})).toBe(false);
 expect(isSecretCandidate({kind:'key',value:'abc',save:true})).toBe(false);
 expect(isSecretCandidate({kind:'card',cardNumber:'4111111111111111'})).toBe(false);
 expect(isSecretCandidate({kind:'key',value:'opaque-credential'})).toBe(true);
});
it('detects known provider format only with generated-result context, including ordinary text', () => {
 document.body.innerHTML='<section><h2>Generated credential</h2><span>ghp_abcdefghijklmnopqrst1234567890</span></section>';
 expect(detectSecretCandidates(document)).toEqual([{kind:'key',value:'ghp_abcdefghijklmnopqrst1234567890'}]);
 document.body.innerHTML='<code>ghp_abcdefghijklmnopqrst1234567890</code>';
 expect(detectSecretCandidates(document)).toEqual([]);
});
it('reads standards independently of arbitrary-language labels', () => {
 document.body.innerHTML='<form><label>番号<input autocomplete="cc-number" value="4111111111111111"></label><label>姓名<input autocomplete="cc-name" value="客人"></label><input autocomplete="cc-exp-month" value="12"><input autocomplete="cc-exp-year" value="2030"></form>';
 expect(detectSecretCandidates(document)[0]).toMatchObject({cardholderName:'客人',expiryMonth:'12',expiryYear:'2030'});
});
it('does not guess between two PANs in one grouping and never captures CVV by default', () => {
 document.body.innerHTML='<form><input autocomplete="cc-number" value="4111111111111111"><input autocomplete="cc-number" value="5555555555554444"><input autocomplete="cc-csc" value="123"></form>';
 expect(detectSecretCandidates(document)).toEqual([]);
 document.querySelectorAll('input')[1]!.remove();
 expect(detectSecretCandidates(document)[0]).not.toHaveProperty('cvv');
});
it('rejects zero-layout fields and restricts scoped scans', () => {
 document.body.innerHTML='<section><input aria-label="API key" value="first-credential"></section><input aria-label="API key" value="second-credential">';
 expect(detectSecretCandidates(document,{scope:document.querySelector('section')!})).toEqual([{kind:'key',value:'first-credential'}]);
 vi.spyOn(HTMLElement.prototype,'getClientRects').mockReturnValue([] as unknown as DOMRectList);
 expect(detectSecretCandidates(document)).toEqual([]);
});
it('rejects invalid boundary values without coercion', () => {
 for(const candidate of [null,[],{kind:'key',value:123},{kind:'key',value:'secret\nvalue'},{kind:'card',cardNumber:'x'.repeat(16),cardholderName:'',expiryMonth:'',expiryYear:''},{kind:'card',cardNumber:'4111111111111111',cardholderName:'',expiryMonth:'13',expiryYear:''}]) expect(isSecretCandidate(candidate)).toBe(false);
});
it('requires payment structure for unnamed PAN and reads unnamed expiry', () => {
 document.body.innerHTML='<form><input value="4111111111111111"></form>';
 expect(detectSecretCandidates(document)).toEqual([]);
 document.body.innerHTML='<form><input value="4111111111111111"><input placeholder="MM/YY" value="12/30"><input maxlength="3" value="123"></form>';
 expect(detectSecretCandidates(document)[0]).toMatchObject({expiryMonth:'12',expiryYear:'30'});
});
it('supports locale-independent trusted generated outputs and explicit key id pair', () => {
 document.body.innerHTML='<section><h2>認証情報を作成しました</h2><output>ghp_abcdefghijklmnopqrst1234567890</output></section>';
 expect(detectSecretCandidates(document,{scope:document.querySelector('section')!,trustedGeneratedResult:true})).toHaveLength(1);
 document.body.innerHTML='<section><label>Key ID<input readonly value="identifier-123"></label><label>API key<input readonly value="opaque-credential"></label></section>';
 expect(detectSecretCandidates(document)).toEqual([{kind:'key',value:'opaque-credential',keyId:'identifier-123'}]);
});
it('resolves nested documentation and generated contexts without reading hidden descendants', () => {
 document.body.innerHTML='<section><h2>API key example documentation</h2><div><label>API key<input readonly value="unknown-format-secret"></label></div></section>';
 expect(detectSecretCandidates(document)).toEqual([]);
 document.body.innerHTML=`<section><h2>Generated API key</h2><div><code><span hidden>${syntheticStripeKey}</span></code></div></section>`;
 expect(detectSecretCandidates(document)).toEqual([]);
 document.body.innerHTML=`<section><h2>Generated API key</h2><div><code>${syntheticStripeKey}</code></div></section>`;
 expect(detectSecretCandidates(document)).toHaveLength(1);
});
it('does not associate document-level auxiliary fields and sees assigned slot controls', () => {
 document.body.innerHTML='<div><input autocomplete="cc-number" value="4111111111111111"></div><div><input autocomplete="cc-name" value="Other"><input autocomplete="cc-exp" value="12/2030"></div>';
 expect(detectSecretCandidates(document)[0]).toMatchObject({cardholderName:'',expiryMonth:'',expiryYear:''});
 const host=document.createElement('div'); host.innerHTML='<input aria-label="API key" readonly value="unknown-format-secret">'; host.attachShadow({mode:'open'}).innerHTML='<slot></slot>'; document.body.replaceChildren(host);
 expect(detectSecretCandidates(document)).toHaveLength(1);
});
it('bounds ancestor style work and rejects oversized raw values and hints', () => {
 let parent=document.body;
 for(let i=0;i<300;i++){const child=document.createElement('div');parent.append(child);parent=child;}
 parent.innerHTML='<input aria-label="API key" value="opaque-credential">';
 const styles=vi.spyOn(window,'getComputedStyle').mockReturnValue({display:'block',visibility:'visible',opacity:'1'} as CSSStyleDeclaration);
 detectSecretCandidates(document,{scope:parent});
 expect(styles.mock.calls.length).toBeLessThanOrEqual(256);
 document.body.innerHTML='<input aria-label="API key">';
 const input=document.querySelector('input')!; input.value='x'.repeat(5000);
 expect(detectSecretCandidates(document)).toEqual([]);
 input.value='opaque-credential';input.setAttribute('aria-label','x'.repeat(10000)+'API key');
 expect(detectSecretCandidates(document)).toEqual([]);
});
it('supports standard select expiry fields and month input date structure', () => {
 document.body.innerHTML='<form><input autocomplete="cc-number" value="4111111111111111"><select autocomplete="cc-exp-month"><option selected value="12">12</option></select><select autocomplete="cc-exp-year"><option selected value="2030">2030</option></select></form>';
 expect(detectSecretCandidates(document)[0]).toMatchObject({expiryMonth:'12',expiryYear:'2030'});
 document.body.innerHTML='<form><input value="4111111111111111"><input type="month" autocomplete="cc-exp" value="2030-12"></form>';
 expect(detectSecretCandidates(document)[0]).toMatchObject({expiryMonth:'12',expiryYear:'2030'});
});
it('accepts known readonly and text results under arbitrary languages only in trusted scoped results', () => {
 for (const heading of ['Generated credential', '認証情報を作成しました', 'Διαπιστευτήριο']) {
  for (const result of ['<output>ghp_abcdefghijklmnopqrst1234567890</output>', '<input readonly value="ghp_abcdefghijklmnopqrst1234567890">', '<span>ghp_abcdefghijklmnopqrst1234567890</span>']) {
   document.body.innerHTML=`<section><h2>${heading}</h2><div>${result}</div></section>`;
   expect(detectSecretCandidates(document,{scope:document.querySelector('section')!,trustedGeneratedResult:true})).toEqual([{kind:'key',value:'ghp_abcdefghijklmnopqrst1234567890'}]);
  }
 }
 document.body.innerHTML='<section><input readonly value="ghp_abcdefghijklmnopqrst1234567890"></section>';
 expect(detectSecretCandidates(document)).toEqual([]);
 expect(detectSecretCandidates(document,{trustedGeneratedResult:true})).toEqual([]);
 document.body.innerHTML='<section><h2>Documentation example</h2><output>ghp_abcdefghijklmnopqrst1234567890</output></section>';
 expect(detectSecretCandidates(document,{scope:document.querySelector('section')!,trustedGeneratedResult:true})).toEqual([]);
});
it('excludes each hidden descendant boundary from visible output', () => {
 for (const hidden of ['hidden', 'inert', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"']) {
  document.body.innerHTML=`<section><h2>Generated API key</h2><code><span ${hidden}>${syntheticStripeKey}</span></code></section>`;
  expect(detectSecretCandidates(document)).toEqual([]);
 }
});
it('collects slotted card controls inside a rendered local group and slot fallback content', () => {
 const host=document.createElement('div');
 host.innerHTML='<input autocomplete="cc-number" value="4111111111111111"><input autocomplete="cc-name" value="Guest"><input autocomplete="cc-exp" value="12/2030">';
 host.attachShadow({mode:'open'}).innerHTML='<form><slot></slot></form>';
 document.body.replaceChildren(host);
 expect(detectSecretCandidates(document)).toEqual([{kind:'card',cardNumber:'4111111111111111',cardholderName:'Guest',expiryMonth:'12',expiryYear:'2030'}]);
 host.shadowRoot!.innerHTML='<slot name="missing"><input aria-label="API key" value="fallback-credential"></slot>';
 expect(detectSecretCandidates(document)).toEqual([{kind:'key',value:'fallback-credential'}]);
});
it('does not merge metadata from unrelated shadow-root controls', () => {
 const host=document.createElement('div');
 host.attachShadow({mode:'open'}).innerHTML='<div><input autocomplete="cc-number" value="4111111111111111"></div><div><input autocomplete="cc-name" value="Other"><input autocomplete="cc-exp" value="12/2030"></div>';
 document.body.replaceChildren(host);
 expect(detectSecretCandidates(document)).toEqual([{kind:'card',cardNumber:'4111111111111111',cardholderName:'',expiryMonth:'',expiryYear:''}]);
});
it('does not bind a section-wide key identifier to multiple key results', () => {
 document.body.innerHTML='<section><label>Key ID<input readonly value="identifier-123"></label><label>API key<input readonly value="first-credential"></label><label>API key<input readonly value="second-credential"></label></section>';
 expect(detectSecretCandidates(document)).toEqual([{kind:'key',value:'first-credential'},{kind:'key',value:'second-credential'}]);
});
it('rejects oversized detector output before extracting a token', () => {
 document.body.innerHTML='<section><h2>Generated API key</h2><code></code></section>';
 document.querySelector('code')!.textContent=syntheticStripePrefix+'a'.repeat(5000);
 expect(detectSecretCandidates(document)).toEqual([]);
});

it.each(['hidden', 'inert', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"'])('excludes hidden non-HTML descendants from visible output: %s', hidden => {
 for (const content of [
  `<svg ${hidden}><text>${syntheticStripeKey}</text></svg>`,
  `<svg><g ${hidden}><text>${syntheticStripeKey}</text></g></svg>`,
  `<math ${hidden}><mtext>${syntheticStripeKey}</mtext></math>`,
 ]) {
  document.body.innerHTML=`<section><h2>Generated API key</h2><code>${content}</code></section>`;
  expect(detectSecretCandidates(document)).toEqual([]);
 }
});
it('retains visible SVG and MathML result text', () => {
 for (const content of [
  `<svg><text>${syntheticStripeKey}</text></svg>`,
  `<math><mtext>${syntheticStripeKey}</mtext></math>`,
 ]) {
  document.body.innerHTML=`<section><h2>Generated API key</h2><code>${content}</code></section>`;
  expect(detectSecretCandidates(document)).toEqual([{kind:'key',value:syntheticStripeKey}]);
 }
});
it('checks visibility through non-HTML ancestors of a scoped HTML result', () => {
 document.body.innerHTML=`<section hidden><svg><g><foreignObject><code aria-label="API key">${syntheticStripeKey}</code></foreignObject></g></svg></section>`;
 expect(detectSecretCandidates(document,{scope:document.querySelector('code')!})).toEqual([]);
});

it('scans externally associated controls under their explicit form without unrelated siblings', () => {
 document.body.innerHTML='<form id="payment"></form><section><input form="payment" autocomplete="cc-number" value="4111111111111111"><input autocomplete="cc-name" value="Unrelated sibling"><input autocomplete="cc-exp" value="09/2099"></section><aside><input form="payment" autocomplete="cc-name" value="Synthetic Associated"><input form="payment" autocomplete="cc-exp-month" value="12"><input form="payment" autocomplete="cc-exp-year" value="2031"></aside>';
 expect(detectSecretCandidates(document,{scope:document.querySelector('form')!})).toEqual([{kind:'card',cardNumber:'4111111111111111',cardholderName:'Synthetic Associated',expiryMonth:'12',expiryYear:'2031'}]);
});
