import { z } from "zod";

export interface SharedUnlockPreferenceScope { readonly apiUrl: string; readonly accountId: string }
interface Storage { get(keys: string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> }
const schema = z.object({ version: z.literal(1), apiUrl: z.string().min(1).max(2048), accountId: z.string().uuid(), pauseId: z.string().uuid().nullable() }).strict();

/** Local denial, not a second account preference. Only an explicitly completed
 * own settings operation may clear its exact pause; peer messages cannot. */
export class SharedUnlockPreferenceGate {
  private readonly storage: Storage;
  private readonly exclusive: <T>(action: () => Promise<T>) => Promise<T>;
  private readonly newId: () => string;
  private tail: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, string>();
  private readonly allowed = new Map<string, boolean>();
  private readonly listeners = new Set<(scope: SharedUnlockPreferenceScope) => void>();
  constructor(storage: Storage, exclusive: <T>(action: () => Promise<T>) => Promise<T> = action => action(), newId: () => string = () => crypto.randomUUID()) {
    this.storage = storage; this.exclusive = exclusive; this.newId = newId;
  }
  subscribe(listener: (scope: SharedUnlockPreferenceScope) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private changed(scope: SharedUnlockPreferenceScope, allowed: boolean): void {
    const key = this.key(scope), previous = this.allowed.get(key);
    this.allowed.set(key, allowed);
    if (previous === allowed || (previous === undefined && allowed)) return;
    for (const listener of [...this.listeners]) { try { listener({ ...scope }); } catch { /* A UI observer cannot bypass the gate. */ } }
  }
  /** A synchronous fence after admission; an unknown scope is not admitted. */
  assertAllowed(scope: SharedUnlockPreferenceScope): void {
    if (this.pending.has(this.key(scope)) || this.allowed.get(this.key(scope)) !== true) throw new Error("Shared unlock is locally paused");
  }
  async isAllowed(scope: SharedUnlockPreferenceScope): Promise<boolean> {
    const selected = { apiUrl: scope.apiUrl, accountId: scope.accountId };
    return this.serial(async () => {
      try {
        const pauseId = await this.load(selected);
        const allowed = !pauseId && !this.pending.has(this.key(selected));
        this.changed(selected, allowed); return allowed;
      } catch { this.changed(selected, false); throw new Error("Shared unlock preference gate unavailable"); }
    });
  }
  /** Cancels observers before any storage wait. A failed write retains RAM denial. */
  pause(scope: SharedUnlockPreferenceScope): { id: string; persisted: Promise<void> } {
    const selected = { apiUrl: scope.apiUrl, accountId: scope.accountId }, key = this.key(selected), id = this.newId();
    this.pending.set(key, id); this.changed(selected, false);
    const persisted = this.serial(async () => {
      await this.save(selected, id);
      if (this.pending.get(key) === id) this.pending.delete(key);
    });
    // Owners await this before claiming a saved preference. Denial remains even
    // if their document goes away before attaching its error handler.
    void persisted.catch(() => {});
    return { id, persisted };
  }
  async complete(scope: SharedUnlockPreferenceScope, pauseId: string, assertOwnCurrent: () => void): Promise<void> {
    const selected = { apiUrl: scope.apiUrl, accountId: scope.accountId }, key = this.key(selected);
    assertOwnCurrent();
    return this.serial(async () => {
      assertOwnCurrent();
      if (this.pending.has(key) || await this.load(selected) !== pauseId) throw new Error("Shared unlock pause changed");
      assertOwnCurrent();
      if (this.pending.has(key)) throw new Error("Shared unlock pause changed");
      try {
        await this.save(selected, null);
        assertOwnCurrent();
        if (this.pending.has(key)) throw new Error("Shared unlock pause changed");
      } catch (error) {
        // A late cancellation must not leave a cleared record for the next process.
        if (!this.pending.has(key)) this.pending.set(key, pauseId);
        this.changed(selected, false);
        const retained = this.pending.get(key)!;
        try {
          await this.save(selected, retained);
          if (this.pending.get(key) === retained) this.pending.delete(key);
        } catch { /* Failed repair retains the denial in RAM. */ }
        throw error;
      }
      this.changed(selected, true);
    });
  }
  /** Another document's storage event is only an invalidation. Re-read the
   * authoritative local record under the origin-wide lock before admission. */
  refreshExternal(scope: SharedUnlockPreferenceScope): void {
    this.changed(scope, false);
    void this.isAllowed(scope).catch(() => {});
  }
  refreshExternalKey(key: string): void {
    if (!this.allowed.has(key)) return;
    const [apiUrl, accountId] = JSON.parse(key.slice("palladin.shared-unlock.pause.v1:".length)) as [string, string];
    this.refreshExternal({ apiUrl, accountId });
  }
  private key(scope: SharedUnlockPreferenceScope): string { return "palladin.shared-unlock.pause.v1:" + JSON.stringify([scope.apiUrl, scope.accountId]); }
  private async load(scope: SharedUnlockPreferenceScope): Promise<string | null> {
    const key = this.key(scope), values = await this.storage.get([key]);
    if (!Object.hasOwn(values, key)) return null;
    const parsed = schema.safeParse(values[key]);
    if (!parsed.success || parsed.data.apiUrl !== scope.apiUrl || parsed.data.accountId !== scope.accountId) throw new Error("Invalid local pause");
    return parsed.data.pauseId;
  }
  private save(scope: SharedUnlockPreferenceScope, pauseId: string | null): Promise<void> {
    return this.storage.set({ [this.key(scope)]: { version: 1, apiUrl: scope.apiUrl, accountId: scope.accountId, pauseId } });
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.exclusive(action));
    this.tail = result.then(() => {}, () => {}); return result;
  }
}
