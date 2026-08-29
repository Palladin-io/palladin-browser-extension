import {
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
  type HubConnection,
} from "@microsoft/signalr";

export interface VaultSyncInvalidation {
  readonly protocolVersion: 1;
  readonly vaultId: string;
  readonly memberSequence: string;
  readonly mutationVersion: string;
  readonly removed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_U64 = /^(0|[1-9][0-9]{0,19})$/;
const MAX_U64 = 18_446_744_073_709_551_615n;

export function parseVaultSyncInvalidation(raw: unknown): VaultSyncInvalidation | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 5
    || !keys.every((key) => [
      "protocolVersion",
      "vaultId",
      "memberSequence",
      "mutationVersion",
      "removed",
    ].includes(key))
    || record.protocolVersion !== 1
    || typeof record.vaultId !== "string"
    || typeof record.memberSequence !== "string"
    || typeof record.mutationVersion !== "string"
    || typeof record.removed !== "boolean"
    || !UUID.test(record.vaultId)
    || !canonicalU64(record.memberSequence)
    || !canonicalU64(record.mutationVersion)) return null;
  return record as unknown as VaultSyncInvalidation;
}

function canonicalU64(value: string): boolean {
  return CANONICAL_U64.test(value) && BigInt(value) <= MAX_U64;
}

export interface VaultInvalidationCoordinatorDeps {
  apply(vaultId: string, removed: boolean): Promise<void>;
  changed(): void;
}

/** Coalesces duplicate/out-of-order hints and serializes work per Vault. */
export class VaultInvalidationCoordinator {
  private readonly pending = new Map<string, VaultSyncInvalidation>();
  private readonly inFlight = new Map<string, bigint>();
  private readonly applied = new Map<string, bigint>();
  private readonly running = new Map<string, Promise<void>>();
  private generation = 0;

  constructor(private readonly deps: VaultInvalidationCoordinatorDeps) {}

  accept(raw: unknown): void {
    const invalidation = parseVaultSyncInvalidation(raw);
    if (invalidation === null) return;
    const rank = invalidationRank(invalidation);
    const queued = this.pending.get(invalidation.vaultId);
    const highestSeen = [
      this.applied.get(invalidation.vaultId) ?? -1n,
      this.inFlight.get(invalidation.vaultId) ?? -1n,
      queued ? invalidationRank(queued) : -1n,
    ].reduce((left, right) => left > right ? left : right);
    if (rank <= highestSeen) return;
    this.pending.set(invalidation.vaultId, invalidation);
    if (!this.running.has(invalidation.vaultId)) {
      this.startDrain(invalidation.vaultId, this.generation);
    }
  }

  clear(): void {
    this.generation += 1;
    this.pending.clear();
    this.inFlight.clear();
    this.applied.clear();
  }

  private startDrain(vaultId: string, generation: number): void {
    this.running.set(vaultId, this.drain(vaultId, generation));
  }

  private async drain(vaultId: string, generation: number): Promise<void> {
    try {
      while (generation === this.generation) {
        const invalidation = this.pending.get(vaultId);
        if (!invalidation) return;
        this.pending.delete(vaultId);
        const rank = invalidationRank(invalidation);
        this.inFlight.set(vaultId, rank);
        try {
          await this.deps.apply(vaultId, invalidation.removed);
          if (generation !== this.generation) return;
          const applied = this.applied.get(vaultId) ?? -1n;
          if (rank > applied) this.applied.set(vaultId, rank);
          this.deps.changed();
        } catch {
          // Unlock/reconnect/15-minute repair sync remains authoritative.
        } finally {
          if (this.inFlight.get(vaultId) === rank) this.inFlight.delete(vaultId);
        }
      }
    } finally {
      this.running.delete(vaultId);
      if (this.pending.has(vaultId)) {
        this.startDrain(vaultId, this.generation);
      }
    }
  }
}

// Access removal can legitimately race the ordinary invalidation emitted by
// the same committed key rotation. For an equal mutation version, the
// tombstone must always dominate so an eventually removed member cannot keep
// a stale Vault merely because the non-removal hint arrived first.
function invalidationRank(invalidation: VaultSyncInvalidation): bigint {
  return BigInt(invalidation.mutationVersion) * 2n + (invalidation.removed ? 1n : 0n);
}

export interface VaultRealtimeConnectionDeps {
  apiUrl(): string;
  accessToken(): Promise<string | null>;
  invalidation(raw: unknown): void;
  repair(): void;
  connectivity?(connected: boolean): void;
}

/** Owns the unlocked worker's one authenticated SignalR connection. */
export class VaultRealtimeConnection {
  private connection: HubConnection | null = null;
  private operation: Promise<void> = Promise.resolve();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private desired = false;

  constructor(private readonly deps: VaultRealtimeConnectionDeps) {}

  start(): void {
    if (this.desired) return;
    this.desired = true;
    const generation = ++this.generation;
    this.operation = this.operation.then(() => this.connect(generation, 0));
  }

  stop(): void {
    this.desired = false;
    ++this.generation;
    this.clearRetry();
    this.operation = this.operation.then(() => this.disconnect());
  }

  private async connect(generation: number, attempt: number): Promise<void> {
    if (!this.desired || generation !== this.generation || this.connection !== null) return;
    const apiUrl = this.deps.apiUrl().replace(/\/$/, "");
    const connection = new HubConnectionBuilder()
      .withUrl(`${apiUrl}/hubs/notifications`, {
        accessTokenFactory: async () => await this.deps.accessToken() ?? "",
      })
      .withAutomaticReconnect([0, 2_000, 5_000, 15_000])
      .configureLogging(LogLevel.None)
      .build();
    connection.on("ReceiveVaultSyncInvalidation", (raw: unknown) => {
      this.deps.invalidation(raw);
    });
    connection.onreconnecting(() => this.deps.connectivity?.(false));
    connection.onreconnected(() => {
      this.deps.connectivity?.(true);
      this.deps.repair();
    });
    connection.onclose(() => {
      this.deps.connectivity?.(false);
      if (this.connection === connection) this.connection = null;
      if (this.desired && generation === this.generation) this.schedule(generation, 0);
    });
    try {
      await connection.start();
      if (!this.desired || generation !== this.generation) {
        await connection.stop();
        return;
      }
      this.connection = connection;
      this.deps.connectivity?.(true);
    } catch {
      this.deps.connectivity?.(false);
      await connection.stop().catch(() => undefined);
      if (this.desired && generation === this.generation) this.schedule(generation, attempt + 1);
    }
  }

  private schedule(generation: number, attempt: number): void {
    this.clearRetry();
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000];
    this.retry = setTimeout(() => {
      this.retry = null;
      this.operation = this.operation.then(() => this.connect(generation, attempt));
    }, delays[Math.min(attempt, delays.length - 1)]);
  }

  private async disconnect(): Promise<void> {
    this.deps.connectivity?.(false);
    const connection = this.connection;
    this.connection = null;
    if (connection && connection.state !== HubConnectionState.Disconnected) {
      await connection.stop().catch(() => undefined);
    }
  }

  private clearRetry(): void {
    if (this.retry === null) return;
    clearTimeout(this.retry);
    this.retry = null;
  }
}
