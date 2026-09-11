import { z } from "zod";

export interface SharedUnlockExpiryScope { readonly apiUrl: string; readonly accountId: string }
interface ExpiryStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}
const schema = z.object({ version: z.literal(1), apiUrl: z.string().min(1).max(2048), accountId: z.string().uuid(),
  throughSequence: z.number().int().min(0).max(0xffff_ffff) }).strict();

/** Denial-only metadata from a previously verified own Identity root. No key,
 * token, source generation or authorization capability is written to storage. */
export class SharedUnlockExpiryStore {
  private receipt: (SharedUnlockExpiryScope & { sequence: number }) | null = null;
  remember(scope: SharedUnlockExpiryScope, sequence: number): void {
    this.receipt = { ...scope, sequence };
  }
  retire(scope: SharedUnlockExpiryScope): void {
    const receipt = this.receipt;
    if (receipt?.apiUrl === scope.apiUrl && receipt.accountId === scope.accountId) {
      void this.advance(scope, receipt.sequence).catch(() => { /* RAM denial remains; admission repairs or fails closed. */ });
    }
  }
  private tail: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, number>();
  private readonly storage: ExpiryStorage;
  private readonly exclusive: <T>(action: () => Promise<T>) => Promise<T>;
  constructor(storage: ExpiryStorage, exclusive: <T>(action: () => Promise<T>) => Promise<T> = action => action()) {
    this.storage = storage; this.exclusive = exclusive;
  }
  advance(scope: SharedUnlockExpiryScope, sequence: number): Promise<void> {
    const selected = { ...scope }, key = this.key(selected);
    this.pending.set(key, Math.max(this.pending.get(key) ?? 0, sequence));
    return this.serial(async () => { await this.readAndRepair(selected); });
  }
  assertFresh(scope: SharedUnlockExpiryScope, sequence: number): Promise<void> {
    const selected = { ...scope };
    return this.serial(async () => {
      const through = await this.readAndRepair(selected);
      if (sequence <= through) throw new Error("Shared unlock authorization was retired locally");
    });
  }
  private key(scope: SharedUnlockExpiryScope): string {
    return "palladin.shared-unlock.expiry.v1:" + JSON.stringify([scope.apiUrl, scope.accountId]);
  }
  private async readAndRepair(scope: SharedUnlockExpiryScope): Promise<number> {
    const key = this.key(scope), values = await this.storage.get([key]);
    let through = 0;
    if (Object.hasOwn(values, key)) {
      const parsed = schema.safeParse(values[key]);
      if (!parsed.success || parsed.data.apiUrl !== scope.apiUrl || parsed.data.accountId !== scope.accountId) throw new Error("Shared unlock expiry record unavailable");
      through = parsed.data.throughSequence;
    }
    const pending = this.pending.get(key);
    if (pending !== undefined) {
      through = Math.max(through, pending);
      await this.storage.set({ [key]: { version: 1, apiUrl: scope.apiUrl, accountId: scope.accountId, throughSequence: through } });
      if (this.pending.get(key) === pending) this.pending.delete(key);
      // A later synchronous retirement must still fence this admission.
      through = Math.max(through, this.pending.get(key) ?? 0);
    }
    return through;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.exclusive(action));
    this.tail = result.then(() => {}, () => {}); return result;
  }
}
