import { Protocol2MutationConflictError } from '../vault/protocol2/client';
import { expect, it, vi } from 'vitest';
import { SecretCaptureCoordinator } from './secret-coordinator';
const card = { kind: 'card', cardNumber: '4111111111111111', cardholderName: 'Test', expiryMonth: '12', expiryYear: '2031' } as const;
const entry = { entryType: 'creditCard', label: 'Visa', ...card } as const;
const source = { tabId: 1, frameId: 0, browserDocumentId: 'top', topDocumentId: 'top', documentId: 'local', url: 'https://shop.test' };
function fixture(createdIdentity = false, resolveIcon?: () => Promise<string | undefined>) {
 let live = true;
 const target = { id: 'card', vaultId: 'v', revision: '1', name: 'My Visa', vaultName: 'Personal', entry: { ...entry, notes: 'Existing note' } };
 const update = vi.fn(async () => ({ status: 'saved' as const }));
 const coordinator = new SecretCaptureCoordinator({session: async () => ({ profileId: 'p', generation: 1, unlocked: true }),
 current: async () => live, activeTabId: async () => 1, muted: async () => false, mute: async () => {},
 vaults: async () => [{ id: 'v', name: 'Personal', isDefault: true }], duplicate: async () => false,
 ...(resolveIcon ? {resolveIcon} : {}),
 save: async () => createdIdentity ? { status: 'saved', entryId: 'new-card', vaultId: 'v' } : { status: 'saved' }, cardTargets: async () => [{...target,entry:{...target.entry}}], update });
 return { coordinator, update, target, navigate: () => { live = false; } };
}
it('offers exact-card targets in native review and saves the worker-owned revision', async () => {
 const f = fixture(); const observed = await f.coordinator.observe(card, source);
 const id = 'id' in observed ? observed.id : '';
 expect(await f.coordinator.beginReview(id)).toMatchObject({ cardTargets: [f.target] });
 expect(await f.coordinator.update(id, 'card', entry)).toEqual({ status: 'saved', entryId: 'card', vaultId: 'v' });
 expect(f.update).toHaveBeenCalledWith(f.target, entry, card.cardNumber, expect.any(Function));
 f.coordinator.clear();
});
it('requires explicit review and rejects unoffered targets, changed PAN, and stale document', async () => {
 const f = fixture(); const observed = await f.coordinator.observe(card, source); const id = 'id' in observed ? observed.id : '';
 expect(await f.coordinator.update(id, 'card', entry)).toEqual({ status: 'stale' });
 await f.coordinator.beginReview(id);
 expect(await f.coordinator.update(id, 'other', entry)).toEqual({ status: 'stale' });
 expect(await f.coordinator.update(id, 'card', {...entry, cardNumber: '5555555555554444'})).toEqual({ status: 'stale' });
 f.navigate(); expect(await f.coordinator.update(id, 'card', entry)).toEqual({ status: 'stale' });
 expect(f.update).not.toHaveBeenCalled(); f.coordinator.clear();
});
it('lets the bound top frame dismiss an iframe notice but never another document', async () => {
 const f = fixture(); const observed = await f.coordinator.observe(card, {...source, frameId: 2, browserDocumentId: 'child', documentId: 'child-local'});
 const id = 'id' in observed ? observed.id : '';
 expect(await f.coordinator.contentStatus({...source, browserDocumentId: 'different'}, id)).toEqual({ status: 'empty' });
 expect(await f.coordinator.contentStatus(source, id)).toEqual({ status: 'dismissed' });
 expect(f.update).not.toHaveBeenCalled(); f.coordinator.clear();
});

it('forwards only the committed create identity to the native saved state', async () => {
 const f = fixture(true); const observed = await f.coordinator.observe(card, source);
 const id = 'id' in observed ? observed.id : '';
 expect(await f.coordinator.save(id, 'v', entry)).toEqual({status:'saved',entryId:'new-card',vaultId:'v'});
 f.coordinator.clear();
});

it('resolves a trusted presentation icon once for native review only', async () => {
 const resolveIcon = vi.fn(async () => 'public-asset:catalog-icon');
 const f = fixture(false, resolveIcon); const observed = await f.coordinator.observe(card, source);
 expect(observed).not.toHaveProperty('icon');
 expect(await f.coordinator.review()).toMatchObject({icon:'public-asset:catalog-icon'});
 await f.coordinator.review(); expect(resolveIcon).toHaveBeenCalledTimes(1);
 expect(await f.coordinator.contentStatus(source)).not.toHaveProperty('icon'); f.coordinator.clear();
});
it('continues review without an icon when catalog lookup is unavailable', async () => {
 const f = fixture(false, async () => {throw new Error('unavailable');});
 await f.coordinator.observe(card, source);
 expect(await f.coordinator.review()).toMatchObject({status:'review'}); f.coordinator.clear();
});
it('does not return review after document change during catalog lookup', async () => {
 const f = fixture(false, async () => { f.navigate(); return 'public-asset:catalog-icon'; });
 await f.coordinator.observe(card, source);
 expect(await f.coordinator.review()).toEqual({status:'stale'}); f.coordinator.clear();
});

it('refreshes a conflicting card revision only after another explicit review', async () => {
 const f = fixture(); const observed = await f.coordinator.observe(card, source); const id = 'id' in observed ? observed.id : '';
 await f.coordinator.beginReview(id);
 f.target.revision = '2'; f.target.entry.notes = 'Changed elsewhere';
 f.update.mockRejectedValueOnce(new Protocol2MutationConflictError());
 expect(await f.coordinator.update(id,'card',entry)).toEqual({status:'review-required'});
 expect(f.update).toHaveBeenCalledTimes(1);
 expect(await f.coordinator.review()).toMatchObject({cardTargets:[{revision:'2',entry:{notes:'Changed elsewhere'}}]});
 expect(await f.coordinator.update(id,'card',entry)).toEqual({status:'stale'});
 expect(f.update).toHaveBeenCalledTimes(1);
 await f.coordinator.beginReview(id);
 expect(await f.coordinator.update(id,'card',entry)).toMatchObject({status:'saved'});
 expect(f.update).toHaveBeenLastCalledWith(expect.objectContaining({revision:'2'}),entry,card.cardNumber,expect.any(Function)); f.coordinator.clear();
});
it('keeps the reviewed target after an ordinary update transport failure', async () => {
 const f = fixture(); const observed = await f.coordinator.observe(card, source); const id = 'id' in observed ? observed.id : '';
 await f.coordinator.beginReview(id); f.update.mockRejectedValueOnce(new Error('network'));
 expect(await f.coordinator.update(id,'card',entry)).toEqual({status:'error'});
 expect(await f.coordinator.update(id,'card',entry)).toMatchObject({status:'saved'});
 expect(f.update).toHaveBeenCalledTimes(2); f.coordinator.clear();
});
