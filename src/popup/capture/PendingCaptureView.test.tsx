// @vitest-environment jsdom
import {render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {PendingCaptureView} from './PendingCaptureView';
import {createVaultClient} from '../vault/client';
afterEach(()=>vi.unstubAllGlobals());
it('rejects a different pending capture instead of displaying whichever candidate is currently available',async()=>{
  vi.stubGlobal('chrome',{runtime:{sendMessage:vi.fn(async()=>({status:'review',id:'different',candidate:{kind:'key',value:'synthetic'},origin:'https://example.test',vaults:[]}))}});
  render(<PendingCaptureView capture={{kind:'secret',id:'requested'}} client={createVaultClient(async()=>{throw Error();})} onDone={()=>{}}/>);
  expect(await screen.findByRole('status')).toHaveTextContent('This capture is no longer available.');
  expect(screen.queryByLabelText('Value')).toBeNull();
  expect(document.body.textContent).not.toContain('synthetic');
});
