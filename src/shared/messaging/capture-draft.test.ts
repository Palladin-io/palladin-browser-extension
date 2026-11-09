import {expect,it} from 'vitest';
import {isCaptureDraft} from './capture-draft';
it('accepts incomplete user input without treating it as save input',()=>{
 expect(isCaptureDraft({kind:'secret',targetId:'',vaultId:'vault',form:{fields:{label:'',cvv:'x',expiryMonth:'99'},customFields:[{id:'custom:1',label:'',type:'totp',value:'otpauth://unfinished'}],methods:[],presentation:{}}})).toBe(true);
});
it('rejects oversized or foreign fields and invalid options at the private message boundary',()=>{
 const base={kind:'totp',targetId:'target',label:'',username:'',replace:false,confirmDomainMismatch:false};
 expect(isCaptureDraft({...base,label:'x'.repeat(513)})).toBe(false);
 expect(isCaptureDraft({...base,entryId:'other'})).toBe(false);
 expect(isCaptureDraft({...base,replace:'true'})).toBe(false);
 expect(isCaptureDraft({kind:'secret',targetId:'',vaultId:'vault',form:{fields:{injected:'value'},customFields:[],methods:[],presentation:{}}})).toBe(false);
});
