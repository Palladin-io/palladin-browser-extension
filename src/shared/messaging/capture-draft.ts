import { isSignInProvider, type SignInProvider } from '../signin/providers';
export interface CaptureFormDraft {
  fields: Record<string,string>;
  customFields: Array<{id:string;label:string;type:'text'|'multiline'|'concealed'|'totp';value:string}>;
  methods: Array<{id:string;provider:SignInProvider;account:string|null;agentVisible:boolean}>;
  presentation: {icon?:string;color?:string};
}
export type CaptureDraft =
 | {kind:'login';targetId:string;accountId:string;methodMode:'create'|'update';entryName:string;autoUpdate:boolean;replace:boolean;form:CaptureFormDraft|null}
 | {kind:'secret';targetId:string;vaultId:string;form:CaptureFormDraft|null}
 | {kind:'totp';targetId:string;label:string;username:string;replace:boolean;confirmDomainMismatch:boolean};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const string=(value:unknown,max=512):value is string=>typeof value==='string'&&value.length<=max;
const keys=(value:Record<string,unknown>,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
const fields=['label','username','password','url','value','source','interpreter','cardholderName','cardNumber','cvv','expiryMonth','expiryYear','billingAddress','notes'];
function form(value:unknown):value is CaptureFormDraft|null {
 if(value===null)return true;
 if(!record(value)||!keys(value,['fields','customFields','methods','presentation'])||!record(value.fields)||!keys(value.fields,fields)||!Object.values(value.fields).every(item=>string(item,65536)))return false;
 if(!Array.isArray(value.customFields)||value.customFields.length>20||!value.customFields.every(item=>record(item)&&keys(item,['id','label','type','value'])&&string(item.id)&&string(item.label,80)&&['text','multiline','concealed','totp'].includes(String(item.type))&&string(item.value,16384)))return false;
 if(!Array.isArray(value.methods)||value.methods.length>20||!value.methods.every(item=>record(item)&&keys(item,['id','provider','account','agentVisible'])&&string(item.id)&&isSignInProvider(item.provider)&&(item.account===null||string(item.account))&&typeof item.agentVisible==='boolean'))return false;
 return record(value.presentation)&&keys(value.presentation,['icon','color'])&&(value.presentation.icon===undefined||string(value.presentation.icon,2048))&&(value.presentation.color===undefined||string(value.presentation.color,128));
}
/** UI draft validation bounds memory and structure only; saving still uses the authoritative capture guards. */
export function isCaptureDraft(value:unknown):value is CaptureDraft {
 if(!record(value)||!string(value.targetId)||JSON.stringify(value).length>512000)return false;
 if(value.kind==='totp')return keys(value,['kind','targetId','label','username','replace','confirmDomainMismatch'])&&string(value.label)&&string(value.username)&&typeof value.replace==='boolean'&&typeof value.confirmDomainMismatch==='boolean';
 if(value.kind==='secret')return keys(value,['kind','targetId','vaultId','form'])&&string(value.vaultId)&&form(value.form);
 return value.kind==='login'&&keys(value,['kind','targetId','accountId','methodMode','entryName','autoUpdate','replace','form'])&&string(value.accountId)&&['create','update'].includes(String(value.methodMode))&&string(value.entryName)&&typeof value.autoUpdate==='boolean'&&typeof value.replace==='boolean'&&form(value.form);
}
export const CAPTURE_DRAFT_CHANNEL='palladin.capture-draft.v1';
