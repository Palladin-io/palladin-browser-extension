import { expect, it } from 'vitest';
import { isCaptureNoticeIdentity } from './capture-notice';
const notice={kind:'credential',site:'example.test',name:'example.test',detail:'synthetic-account'};
it('accepts bounded presentation metadata and rejects untrusted image destinations',()=>{
  expect(isCaptureNoticeIdentity(notice)).toBe(true);
  expect(isCaptureNoticeIdentity({...notice,iconDataUrl:'data:image/png;base64,aGVsbG8='})).toBe(true);
  for(const iconDataUrl of ['https://tracker.example.test/icon','data:image/svg+xml,<svg/>','javascript:alert(1)'])expect(isCaptureNoticeIdentity({...notice,iconDataUrl})).toBe(false);
  expect(isCaptureNoticeIdentity({...notice,password:'must-not-cross'})).toBe(false);
  expect(isCaptureNoticeIdentity({...notice,detail:'a'.repeat(4097)})).toBe(false);
});
