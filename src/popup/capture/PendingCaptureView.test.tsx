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
it('consumes a handoff once across StrictMode effect replay and restores its edits',async()=>{
 const {StrictMode}=await import('react');
 let reads=0;
 vi.stubGlobal('chrome',{runtime:{sendMessage:vi.fn(async command=>{
  if(command.channel==='palladin.capture-draft.v1')return {draft:++reads===1?{kind:'totp',targetId:'create',label:'Edited draft',username:'edited-account',replace:false,confirmDomainMismatch:false}:null};
  return {status:'ready',id:'capture',origin:'https://example.test',entryScope:null,account:'original',issuer:null,targets:[{id:'create',action:'create',label:'Create',vaultLabel:'Personal',vaultId:'vault',entryId:null,domainMismatch:false,hasTotp:false}],defaultTargetId:null};
 })}});
 render(<StrictMode><PendingCaptureView capture={{kind:'totp',id:'capture'}} client={createVaultClient(async()=>{throw Error();})} onDone={()=>{}}/></StrictMode>);
 expect(await screen.findByLabelText('Name')).toHaveValue('Edited draft');
 expect(reads).toBe(1);
});
