import { expect, it, vi } from 'vitest';
import { resolveCaptureNoticeIcon } from './notice-icon';
it('resolves only the captured service through the existing approved asset loader',async()=>{
  const resolve=vi.fn(async()=> 'public-reference'),load=vi.fn(async()=> 'data:image/png;base64,aGVsbG8=');
  const notice={kind:'key' as const,site:'example.test',name:'example.test',detail:''};
  expect(await resolveCaptureNoticeIcon(notice,resolve,load)).toMatchObject({iconDataUrl:'data:image/png;base64,aGVsbG8='});
  expect(resolve).toHaveBeenCalledWith('https://example.test');expect(load).toHaveBeenCalledWith('public-reference');
});
it('keeps card logos local and gracefully handles unavailable favicons',async()=>{
  const resolve=vi.fn(async()=>{throw Error('offline')}),load=vi.fn(async()=>undefined);
  const notice={kind:'card' as const,site:'pay.example.test',name:'Visa',detail:'•••• 4242'};
  expect(await resolveCaptureNoticeIcon(notice,resolve,load)).toEqual(notice);expect(resolve).not.toHaveBeenCalled();
  const key={...notice,kind:'key' as const};expect(await resolveCaptureNoticeIcon(key,resolve,load)).toEqual(key);
});
