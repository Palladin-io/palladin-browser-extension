// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { loginTargetFor, performFill } from './fill';
import { detectSecretCandidates } from './secret-detection';
const fixture = readFileSync('tests/fixtures/forms/capturelab-card/page.html', 'utf8');
beforeEach(() => {
 document.body.innerHTML = fixture;
 vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({width:100,height:43} as DOMRect);
 vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{width:100,height:43}] as unknown as DOMRectList);
});
it('rejects masked card CVC as a user/Agent login and explicit Credential fill target', () => {
 expect([...document.querySelectorAll('input')].map(loginTargetFor).filter(Boolean)).toEqual([]);
 expect(performFill(document, [{kind:'password',value:'SyntheticPortalPassword!'}]).ok).toBe(false);
 expect(document.querySelector<HTMLInputElement>('[name=cvc]')!.value).toBe('');
});
it.each(['123','1234'])('captures masked %s CVC from the payment form', cvv => {
 for(const [name,value] of Object.entries({cardholder:'Synthetic Cardholder',month:'12',year:'2031',cvc:cvv,number:'4242424242424242'})) {
  document.querySelector<HTMLInputElement>(`[name=${name}]`)!.value=value;
 }
 expect(detectSecretCandidates(document)).toEqual([expect.objectContaining({kind:'card',cvv})]);
});
it.each(['SyntheticPortalPassword!','12','12345'])('omits invalid CVC without collecting it as a secret', cvv => {
 document.querySelector<HTMLInputElement>('[name=number]')!.value='4242424242424242';
 document.querySelector<HTMLInputElement>('[name=cvc]')!.value=cvv;
 const candidates=detectSecretCandidates(document);
 expect(candidates).toHaveLength(1);
 expect(candidates[0]).not.toHaveProperty('cvv');
});
it('preserves ordinary login beside checkout and never substitutes its password for CVC', () => {
 document.body.insertAdjacentHTML('afterbegin', '<form id="login"><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Sign in</button></form>');
 const login=document.querySelector<HTMLFormElement>('#login')!;
 expect(loginTargetFor(login.querySelector('input')!)?.password).toBe(login.querySelector('[type=password]'));
 expect(performFill(document,[{kind:'password',value:'1234'}]).ok).toBe(true);
 expect(document.querySelector<HTMLInputElement>('[name=cvc]')!.value).toBe('');
 document.querySelector<HTMLInputElement>('[name=number]')!.value='4242424242424242';
 const candidates=detectSecretCandidates(document);
 expect(candidates).toHaveLength(1);
 expect(candidates[0]).not.toHaveProperty('cvv');
});
it('keeps explicit card CVV fill available for masked payment controls', () => {
 expect(performFill(document,[{kind:'card-cvv',value:'739'}]).ok).toBe(true);
 expect(document.querySelector<HTMLInputElement>('[name=cvc]')!.value).toBe('739');
});
