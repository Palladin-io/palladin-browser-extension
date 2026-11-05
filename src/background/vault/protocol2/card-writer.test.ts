import { beforeEach, expect, it, vi } from 'vitest';
import { Protocol2CredentialWriter, type CredentialWriterDeps } from './credential-writer';
import { VaultKeyEpochFloor } from './key-epoch-floor';
const mocks = vi.hoisted(() => ({ openVaultProjection: vi.fn(), openCurrentMemberSecret: vi.fn(), openVaultDerivedEnvelope: vi.fn(), sealCurrentCanonicalEntry: vi.fn(), buildCanonicalGrantEnvelope: vi.fn(), wipe: vi.fn() }));
vi.mock('@palladin/crypto', async original => ({...await original<typeof import('@palladin/crypto')>(), ...mocks}));
const pan = '4111111111111111';
const secret = { schema: 'palladin.member-secret.v1', entryType: 'creditCard', memberLabel: 'My Visa', agentLabel: null, discoverable: false, description: null, icon: null, color: null, agentFieldAccess: Object.fromEntries(['memberLabel','agentLabel','description','icon','color','entryType','creditCard.cardholderName','creditCard.cardNumber','creditCard.cvv','creditCard.expiryMonth','creditCard.expiryYear','creditCard.billingAddress','notes'].map(id => [id, 'never'])), content: {cardNumber: pan, cardholderName: 'Holder', expiryMonth: '12', expiryYear: '2031', cvv: '123', billingAddress: 'Address', notes: 'Note', customFields: []} };
const vault = { id: 'v', organizationId: 'o', memberKeyGeneration: 1, currentKeyEpoch: { vaultKeyVersion: 1, vdkVersion: 1 }, discoveryKey: {} };
const detail = { id: 'e', vaultId: 'v', organizationId: 'o', state: 'active', currentRevision: '1', memberIndexRevision: '1', agentDiscoveryRevisionHighWatermark: '1', currentKeyVersion: 1, deliveryPolicy: 'injectOnly', entryKey: {}, memberSecret: {} };
const client = { listVaults: vi.fn(), getVault: vi.fn(), getEntry: vi.fn(), getActiveGrants: vi.fn(), updateEntry: vi.fn() };
const data = { refresh: vi.fn(), getMetadata: vi.fn() };
const canWrite = vi.fn(); const authorized = vi.fn(); let writer: Protocol2CredentialWriter;
const target = { id: 'e', vaultId: 'v', revision: '1', name: 'My Visa', vaultName: 'Personal', entry: { entryType: 'creditCard' as const, label: 'My Visa', ...secret.content } };
beforeEach(() => {
 vi.resetAllMocks(); const privateKey = new Uint8Array(32);
 client.listVaults.mockResolvedValue([{id:'v'}]); client.getVault.mockResolvedValue(vault); client.getEntry.mockResolvedValue(detail); client.getActiveGrants.mockResolvedValue([]); client.updateEntry.mockResolvedValue({currentRevision:'2'});
 data.refresh.mockResolvedValue([{id:'e',vaultId:'v',type:3}]); mocks.openVaultProjection.mockResolvedValue({vaultKey:new Uint8Array(32),metadata:{name:'Personal'}}); mocks.openCurrentMemberSecret.mockResolvedValue(secret); mocks.openVaultDerivedEnvelope.mockResolvedValue(new Uint8Array(32)); mocks.sealCurrentCanonicalEntry.mockResolvedValue({entryKey:{},memberSecret:{},memberIndex:{},agentDiscovery:null});
 canWrite.mockResolvedValue(true); authorized.mockResolvedValue(true);
 writer = new Protocol2CredentialWriter({client,data,canWrite,keyEpochFloor:new VaultKeyEpochFloor(),session:{getUserId:async()=> 'u',getPrivateKey:()=>privateKey,getAccessToken:async()=> 'token'}} as unknown as CredentialWriterDeps);
});
it('matches full normalized PAN only and carries existing details into native review', async () => {
 expect(await writer.cardChoices('4111 1111 1111 1111')).toMatchObject([{id:'e',entry:{label:'My Visa',notes:'Note',billingAddress:'Address',cvv:'123'}}]);
 expect(await writer.cardChoices('5555555555551111')).toEqual([]);
 canWrite.mockResolvedValue(false); expect(await writer.cardChoices(pan)).toEqual([]);
});
it('updates reviewed fields preserving policy, unedited metadata, and authoritative revision', async () => {
 await writer.updateCard(target, {...target.entry, notes:'Edited',cvv:'999'}, pan, authorized);
 expect(mocks.sealCurrentCanonicalEntry.mock.calls[0]?.[1]).toMatchObject({...secret,content:{...secret.content,notes:'Edited',cvv:'999'}});
 expect(client.updateEntry).toHaveBeenCalledWith('token',expect.objectContaining({entryId:'e',baseRevision:'1',deliveryPolicy:'injectOnly'}));
});
it.each(['pan','revision','organization','authorization','permission'] as const)('rejects changed %s before mutation', async reason => {
 if(reason==='pan') mocks.openCurrentMemberSecret.mockResolvedValue({...secret,content:{...secret.content,cardNumber:'5555555555551111'}});
 if(reason==='revision') client.getEntry.mockResolvedValue({...detail,currentRevision:'2'});
 if(reason==='organization') client.getEntry.mockResolvedValue({...detail,organizationId:'other'});
 if(reason==='authorization') authorized.mockResolvedValue(false);
 if(reason==='permission') canWrite.mockResolvedValue(false);
 await expect(writer.updateCard(target,target.entry,pan,authorized)).rejects.toThrow(); expect(client.updateEntry).not.toHaveBeenCalled();
});

it('rejects an unsupported legacy card grant instead of discarding its protection', async () => {
 mocks.openCurrentMemberSecret.mockResolvedValue({...secret,agentFieldAccess:{...secret.agentFieldAccess,'creditCard.cardNumber':'onGrantRuntime'}});
 client.getActiveGrants.mockResolvedValue([{id:'grant',vaultId:'v',type:'granular',agentId:'agent',agentPublicKey:'AQ==',recipientAgentKeyVersion:1,
   entryId:'e',methods:'inject',entryScopes:[{entryId:'e',fieldIds:['creditCard.cardNumber'],grantEnvelopeRevision:'1',grantKeyVersion:1}],scriptScopes:[],expiresAt:null,queryLimit:null}]);
 mocks.buildCanonicalGrantEnvelope.mockResolvedValue({ciphertext:'synthetic-envelope'});
 await expect(writer.updateCard(target,target.entry,pan,authorized)).rejects.toThrow('Grant field policy changed');
 expect(client.updateEntry).not.toHaveBeenCalled();
});
it('rechecks authorization after encryption before sending', async () => {
 mocks.sealCurrentCanonicalEntry.mockImplementation(async () => {authorized.mockResolvedValue(false);return {entryKey:{},memberSecret:{},memberIndex:{},agentDiscovery:null};});
 await expect(writer.updateCard(target,target.entry,pan,authorized)).rejects.toThrow();
 expect(client.updateEntry).not.toHaveBeenCalled();
});

it('includes canonical custom TOTP fields in review and preserves them on update', async () => {
 const field = {id:'custom:12345678',label:'Authenticator',type:'totp',value:{secret:'JBSWY3DPEHPK3PXP',algorithm:'SHA1',digits:6,period:30}};
 mocks.openCurrentMemberSecret.mockResolvedValue({...secret,agentFieldAccess:{...secret.agentFieldAccess,[field.id]:'never'},content:{...secret.content,customFields:[field]}});
 const choices = await writer.cardChoices(pan);
 expect(choices[0]?.entry.customFields).toEqual([field]);
 await writer.updateCard(choices[0]!, choices[0]!.entry, pan, authorized);
 expect(mocks.sealCurrentCanonicalEntry.mock.calls[0]?.[1]).toMatchObject({content:{customFields:[field]}});
});
