import { z } from "zod";

export interface SharedUnlockExpiryScope { readonly apiUrl: string; readonly accountId: string }
interface ExpiryStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}
const sequenceSchema = z.number().int().min(0).max(0xffff_ffff);
const checkpointSchema = z.object({ sequence: sequenceSchema, deadlineMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const fields = { apiUrl: z.string().min(1).max(2048), accountId: z.string().uuid(), throughSequence: sequenceSchema };
const schema = z.union([
  z.object({ version: z.literal(1), ...fields }).strict(),
  z.object({ version: z.literal(2), ...fields, checkpoint: checkpointSchema.nullable() }).strict(),
]);
type Checkpoint = z.infer<typeof checkpointSchema>;
interface RecordState { throughSequence: number; checkpoint: Checkpoint | null }
const mergeCheckpoint = (a: Checkpoint | null, b: Checkpoint | null): Checkpoint | null => {
  if (!a) return b;
  if (!b) return a;
  if (a.sequence !== b.sequence) return a.sequence > b.sequence ? a : b;
  return { sequence: a.sequence, deadlineMs: Math.min(a.deadlineMs, b.deadlineMs) };
};

/** Denial-only metadata from a previously verified own Identity root. No key,
 * token, source generation or authorization capability is written to storage. */
export class SharedUnlockExpiryStore {
  private receipt: (SharedUnlockExpiryScope & { sequence: number }) | null = null;
  remember(scope: SharedUnlockExpiryScope, sequence: number): void { this.receipt = { ...scope, sequence }; }
  retire(scope: SharedUnlockExpiryScope): void {
    const receipt = this.receipt;
    if (receipt?.apiUrl === scope.apiUrl && receipt.accountId === scope.accountId) {
      void this.advance(scope, receipt.sequence).catch(() => { /* RAM denial remains; admission repairs or fails closed. */ });
    }
  }
  private tail: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, RecordState>();
  private readonly storage: ExpiryStorage;
  private readonly exclusive: <T>(action: () => Promise<T>) => Promise<T>;
  constructor(storage: ExpiryStorage, exclusive: <T>(action: () => Promise<T>) => Promise<T> = action => action(),
    private readonly now: () => number = Date.now) {
    this.storage = storage; this.exclusive = exclusive;
  }
  advance(scope: SharedUnlockExpiryScope, sequence: number): Promise<void> {
    const selected = { ...scope };
    this.queue(selected, { throughSequence: sequence, checkpoint: null });
    return this.serial(async () => { await this.readAndRepair(selected); });
  }
  assertFresh(scope: SharedUnlockExpiryScope, sequence: number): Promise<void> {
    const selected = { ...scope };
    return this.serial(async () => { this.assertSequence(await this.readAndRepair(selected), sequence); });
  }
  /** Called with verified OWN Identity sequence and effective own limits before
   * publishing keys/authority. A new document/worker cannot renew the same root. */
  checkpoint(scope: SharedUnlockExpiryScope, sequence: number, deadlineMs: number): Promise<number> {
    const selected = { ...scope };
    this.queue(selected, { throughSequence: 0, checkpoint: { sequence, deadlineMs } });
    return this.serial(async () => {
      const record = await this.readAndRepair(selected);
      this.assertSequence(record, sequence);
      return record.checkpoint!.deadlineMs;
    });
  }
  private assertSequence(record: RecordState, sequence: number): void {
    if (sequence <= record.throughSequence || (record.checkpoint && sequence < record.checkpoint.sequence)) {
      throw new Error("Shared unlock authorization was retired locally");
    }
  }
  private key(scope: SharedUnlockExpiryScope): string {
    return "palladin.shared-unlock.expiry.v1:" + JSON.stringify([scope.apiUrl, scope.accountId]);
  }
  private merge(a: RecordState, b?: RecordState): RecordState {
    let throughSequence = Math.max(a.throughSequence, b?.throughSequence ?? 0);
    let checkpoint = mergeCheckpoint(a.checkpoint, b?.checkpoint ?? null);
    if (checkpoint && this.now() >= checkpoint.deadlineMs) throughSequence = Math.max(throughSequence, checkpoint.sequence);
    if (checkpoint && checkpoint.sequence <= throughSequence) checkpoint = null;
    return { throughSequence, checkpoint };
  }
  private queue(scope: SharedUnlockExpiryScope, next: RecordState): void {
    const key = this.key(scope);
    this.pending.set(key, this.merge(next, this.pending.get(key)));
  }
  private async readAndRepair(scope: SharedUnlockExpiryScope): Promise<RecordState> {
    const key = this.key(scope), values = await this.storage.get([key]);
    let previous: RecordState = { throughSequence: 0, checkpoint: null };
    if (Object.hasOwn(values, key)) {
      const parsed = schema.safeParse(values[key]);
      if (!parsed.success || parsed.data.apiUrl !== scope.apiUrl || parsed.data.accountId !== scope.accountId) throw new Error("Shared unlock expiry record unavailable");
      previous = { throughSequence: parsed.data.throughSequence, checkpoint: parsed.data.version === 2 ? parsed.data.checkpoint : null };
    }
    const pending = this.pending.get(key), record = this.merge(previous, pending);
    if (pending || previous.throughSequence !== record.throughSequence) {
      await this.storage.set({ [key]: { version: 2, apiUrl: scope.apiUrl, accountId: scope.accountId, ...record } });
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
    // A later synchronous retirement and time passing during storage still fence admission.
    return this.merge(record, this.pending.get(key));
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.exclusive(action));
    this.tail = result.then(() => {}, () => {}); return result;
  }
}
