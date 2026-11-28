// @vitest-environment jsdom
import {render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {PendingCaptureView} from './PendingCaptureView';
import {createVaultClient} from '../vault/client';
afterEach(()=>vi.unstubAllGlobals());
it('rejects a different pending capture instead of displaying whichever candidate is currently available',async()=>{
  vi.stubGlobal('chrome',{runtime:{sendMessage:vi.fn(async()=>({status:'review',id:'different',candidate:{kind:'key',value:'synthetic'},origin:'https://example.test',vaults:[]}))}});
  render(<PendingCaptureView onOpenEntry={()=>{}} capture={{kind:'secret',id:'requested'}} client={createVaultClient(async()=>{throw Error();})} onDone={()=>{}}/>);
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
 render(<StrictMode><PendingCaptureView onOpenEntry={()=>{}} capture={{kind:'totp',id:'capture'}} client={createVaultClient(async()=>{throw Error();})} onDone={()=>{}}/></StrictMode>);
 expect(await screen.findByLabelText('Name')).toHaveValue('Edited draft');
 expect(reads).toBe(1);
});
it.each(['key','card'])('keeps the edited saved %s summary and opens the receipt entry after native handoff',async kind=>{
 const {fireEvent}=await import('@testing-library/react');
 const open=vi.fn();
 vi.stubGlobal('chrome',{runtime:{sendMessage:vi.fn(async command=>{
  if(command.channel==='palladin.capture-draft.v1')return {draft:null};
  if(command.type==='save'||command.type==='update')return {status:'saved',entryId:'saved-entry',vaultId:'saved-vault'};
  return {status:'review',id:'capture',origin:'https://example.test',candidate:kind==='key'?{kind:'key',value:'synthetic-key'}:{kind:'card',cardNumber:'4111111111111111',cardholderName:'Synthetic',expiryMonth:'12',expiryYear:'2031'},...(kind==='card'?{cardTargets:[{id:'saved-entry',vaultId:'saved-vault',revision:'1',name:'Old card',vaultName:'Personal',entry:{entryType:'creditCard',label:'Old card',cardNumber:'4111111111111111',cardholderName:'Synthetic',expiryMonth:'01',expiryYear:'2030'}}]}:{}),vaults:[{id:'saved-vault',name:'Personal',isDefault:true}]};
 })}});
 render(<PendingCaptureView {...{onOpenEntry:open}} capture={{kind:'secret',id:'capture'}} client={createVaultClient(async()=>{throw Error();})} onDone={()=>{}}/>);
 fireEvent.change(await screen.findByLabelText('Name'),{target:{value:'Edited item'}});
 fireEvent.click(screen.getByRole('button',{name:kind==='key'?'Save key':'Update card'}));
 const thumbnail=await screen.findByRole('button',{name:'Edited item'});
 expect(screen.queryByLabelText('Secret value')).toBeNull();
 expect(screen.queryByLabelText('Card number')).toBeNull();
 if(kind==='card')expect(screen.getByRole('status')).toHaveTextContent('Updated');
 fireEvent.click(thumbnail);
 expect(open).toHaveBeenCalledWith('saved-entry','saved-vault');
});
