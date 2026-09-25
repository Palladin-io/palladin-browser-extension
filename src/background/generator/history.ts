import { openGeneratorHistory, sealGeneratorHistory, wipe, type GeneratorHistoryContext } from '@palladin/crypto';
import type { StorageArea } from '../session/session-store';

export const GENERATOR_HISTORY_CAPACITY = 200;
export interface HistoryItem {
  readonly id: string;
  readonly origin: string | null;
  readonly createdAt: number;
}
interface HistoryRecord extends HistoryItem { readonly value: string }
export interface HistorySession extends GeneratorHistoryContext {
  readonly privateKey: Uint8Array;
  assertCurrent(): void;
}
export class GeneratorHistoryError extends Error {
  constructor(readonly code: 'locked' | 'full' | 'unavailable') { super(code); }
}

export class GeneratorHistory {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: StorageArea, private readonly session: () => Promise<HistorySession>) {}

  remember(value: string, origin: string | null): Promise<void> {
    return this.run(async (session) => {
      if (value.length < 8 || value.length > 4096 || (origin !== null &&
        (origin.length > 2048 || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin))) {
        throw new GeneratorHistoryError('unavailable');
      }
      const records = await this.read(session);
      if (records.some(record => record.value === value && record.origin === origin)) return;
      if (records.length >= GENERATOR_HISTORY_CAPACITY) throw new GeneratorHistoryError('full');
      records.unshift({ id: crypto.randomUUID(), origin, createdAt: Date.now(), value });
      await this.write(session, records);
    });
  }

  list(): Promise<HistoryItem[]> {
    return this.run(async session => (await this.read(session)).map(({ id, origin, createdAt }) => ({ id, origin, createdAt })));
  }

  reveal(id: string): Promise<string> {
    return this.run(async session => {
      const value = (await this.read(session)).find(record => record.id === id)?.value;
      if (value === undefined) throw new GeneratorHistoryError('unavailable');
      return value;
    });
  }

  remove(id: string): Promise<void> {
    return this.run(async session => this.write(session, (await this.read(session)).filter(record => record.id !== id)));
  }

  clear(): Promise<void> {
    return this.run(async session => { await this.storage.remove([this.storageKey(session)]); });
  }

  private async run<T>(action: (session: HistorySession) => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      try {
        const session = await this.session();
        session.assertCurrent();
        const value = await action(session);
        session.assertCurrent();
        return value;
      } catch (error) {
        if (error instanceof GeneratorHistoryError) throw error;
        throw new GeneratorHistoryError('unavailable');
      }
    });
    this.pending = result.catch(() => undefined);
    return result;
  }

  private storageKey(session: HistorySession): string {
    return `palladin.generator-history.v1:${encodeURIComponent(session.apiUrl)}:${session.accountId}`;
  }

  private async read(session: HistorySession): Promise<HistoryRecord[]> {
    const key = this.storageKey(session);
    const data = await this.storage.get([key]);
    session.assertCurrent();
    if (data[key] === undefined) return [];
    const bytes = await openGeneratorHistory(data[key], session.privateKey, session);
    try {
      session.assertCurrent();
      const records: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!Array.isArray(records) || records.length > GENERATOR_HISTORY_CAPACITY || !records.every(isHistoryRecord)
        || new Set(records.map(record => record.id)).size !== records.length) throw new GeneratorHistoryError('unavailable');
      return records;
    } finally { wipe(bytes); }
  }

  private async write(session: HistorySession, records: HistoryRecord[]): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(records));
    try {
      const envelope = await sealGeneratorHistory(bytes, session.privateKey, session);
      session.assertCurrent();
      await this.storage.set({ [this.storageKey(session)]: envelope });
      session.assertCurrent();
    } finally { wipe(bytes); }
  }
}

function isHistoryRecord(value: unknown): value is HistoryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && /^[0-9a-f-]{36}$/.test(record.id)
    && (record.origin === null || (typeof record.origin === 'string' && record.origin.length <= 2048
      && URL.canParse(record.origin) && new URL(record.origin).protocol === 'https:' && new URL(record.origin).origin === record.origin))
    && typeof record.value === 'string' && record.value.length >= 8 && record.value.length <= 4096
    && typeof record.createdAt === 'number' && Number.isSafeInteger(record.createdAt) && record.createdAt > 0;
}
