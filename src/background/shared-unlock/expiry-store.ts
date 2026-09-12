import { z } from "zod";

/** Local denial of a previously retired own authorization. It cannot be repaired
 * by reconnecting the same peer or replaying a handoff from that authority. */
export class SharedUnlockAuthorizationRetiredError extends Error {
  constructor() { super("Shared unlock authorization was retired locally"); }
}

export interface SharedUnlockExpiryScope { readonly apiUrl: string; readonly accountId: string }
interface ExpiryStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}
const sequenceSchema = z.number().int().min(0).max(0xffff_ffff);
const timeSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const legacyCheckpointSchema = z.object({ sequence: sequenceSchema, deadlineMs: timeSchema }).strict();
const checkpointSchema = legacyCheckpointSchema.extend({ hardDeadlineMs: timeSchema }).strict()
  .refine(value => value.deadlineMs <= value.hardDeadlineMs, "Checkpoint exceeds its hard ceiling");
const fields = { apiUrl: z.string().min(1).max(2048), accountId: z.string().uuid(), throughSequence: sequenceSchema };
const schema = z.union([
  z.object({ version: z.literal(1), ...fields }).strict(),
  z.object({ version: z.literal(2), ...fields, checkpoint: legacyCheckpointSchema.nullable() }).strict(),
  z.object({ version: z.literal(3), ...fields, checkpoint: checkpointSchema.nullable() }).strict(),
]);
type Checkpoint = z.infer<typeof checkpointSchema>;
interface RecordState { throughSequence: number; checkpoint: Checkpoint | null }
const mergeCheckpoint = (a: Checkpoint | null, b: Checkpoint | null): Checkpoint | null => {
  if (!a) return b;
  if (!b) return a;
  if (a.sequence !== b.sequence) return a.sequence > b.sequence ? a : b;
  return { sequence: a.sequence, deadlineMs: Math.min(a.deadlineMs, b.deadlineMs), hardDeadlineMs: Math.min(a.hardDeadlineMs, b.hardDeadlineMs) };
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
    private readonly now: () => number = () => Date.now()) {
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
  checkpoint(scope: SharedUnlockExpiryScope, sequence: number, deadlineMs: number, hardDeadlineMs = deadlineMs): Promise<number> {
    const selected = { ...scope };
    this.queue(selected, { throughSequence: 0, checkpoint: { sequence, deadlineMs: Math.min(deadlineMs, hardDeadlineMs), hardDeadlineMs } });
    return this.serial(async () => {
      const record = await this.readAndRepair(selected);
      this.assertSequence(record, sequence);
      return record.checkpoint!.deadlineMs;
    });
  }
  /** Only real own input with an independently captured live key/session/root
   * may call this. Handoff/checkpoint, peer messages and restart never renew. */
  renewOwn(scope: SharedUnlockExpiryScope, sequence: number, deadlineMs: number, assertOwnCurrent: () => void): Promise<void> {
    const selected = { ...scope };
    assertOwnCurrent();
    return this.serial(async () => {
      assertOwnCurrent();
      const record = await this.readAndRepair(selected);
      assertOwnCurrent();
      this.assertSequence(record, sequence);
      const checkpoint = record.checkpoint;
      if (!checkpoint || checkpoint.sequence !== sequence) throw new Error("Shared unlock own checkpoint unavailable");
      const next = { ...checkpoint, deadlineMs: Math.max(checkpoint.deadlineMs, Math.min(deadlineMs, checkpoint.hardDeadlineMs)) };
      // A renewal is never placed in the failed-write repair queue: only a
      // successful write by this still-live owner may relax an idle denial.
      if (next.deadlineMs > checkpoint.deadlineMs) {
        await this.storage.set({ [this.key(selected)]: { version: 3, apiUrl: selected.apiUrl, accountId: selected.accountId, ...record, checkpoint: next } });
        assertOwnCurrent();
        const latest = this.merge({ ...record, checkpoint: next }, this.pending.get(this.key(selected)));
        this.assertSequence(latest, sequence);
      }
    });
  }
  private assertSequence(record: RecordState, sequence: number): void {
    if (sequence <= record.throughSequence || (record.checkpoint && sequence < record.checkpoint.sequence)) {
      throw new SharedUnlockAuthorizationRetiredError();
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
      previous = { throughSequence: parsed.data.throughSequence, checkpoint: parsed.data.version === 1 || !parsed.data.checkpoint ? null
        : parsed.data.version === 3 ? parsed.data.checkpoint
          : { ...parsed.data.checkpoint, hardDeadlineMs: parsed.data.checkpoint.deadlineMs } };
    }
    const pending = this.pending.get(key), record = this.merge(previous, pending);
    if (pending || previous.throughSequence !== record.throughSequence) {
      await this.storage.set({ [key]: { version: 3, apiUrl: scope.apiUrl, accountId: scope.accountId, ...record } });
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
