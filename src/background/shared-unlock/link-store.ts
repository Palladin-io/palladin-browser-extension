import { z } from "zod";
import type { StorageArea } from "../session/session-store";
import type { SharedUnlockLink } from "./api-types";

export interface SharedUnlockLinkScope {
  readonly apiUrl: string;
  readonly webOrigin: string;
  readonly extensionId: string;
  readonly accountId: string;
}
export type SharedUnlockClosingAction = "lock" | "logout" | "disconnect";
export interface SharedUnlockClosingIntent {
  readonly id: string;
  readonly action: SharedUnlockClosingAction;
  readonly expectedRevision: number;
  readonly preferenceRevision: number | null;
}
export interface SharedUnlockLinkMarker extends SharedUnlockLinkScope {
  readonly version: 1;
  readonly linkId: string;
  /** Last observed Identity state, a repair hint, never current authority. */
  readonly observed: SharedUnlockLink | null;
  readonly pending: readonly SharedUnlockClosingIntent[];
  /** Local revocation latch cleared only by the exact explicit reconnect. */
  readonly disconnectId: string | null;
}

const uint = z.number().int().min(0).max(0xffff_ffff);
const uuid = z.string().uuid();
const linkSchema = z.object({ linkId: uuid, revision: uint, epoch: uint,
  state: z.enum(["active", "locked", "revoked"]), lastInvalidationSequence: uint, lastLogoutSequence: uint }).strict();
const markerSchema = z.object({ version: z.literal(1), apiUrl: z.string().min(1).max(2048),
  webOrigin: z.string().min(1).max(2048), extensionId: z.string().min(1).max(256), accountId: uuid, linkId: uuid,
  observed: linkSchema.nullable(), disconnectId: uuid.nullable(), pending: z.array(z.object({ id: uuid, action: z.enum(["lock", "logout", "disconnect"]),
    expectedRevision: uint, preferenceRevision: uint.nullable() }).strict()).max(2) }).strict();

export class SharedUnlockLinkStorageError extends Error {
  constructor() { super("Shared unlock local link is unavailable"); }
}

/** One worker owns writes. Logout deliberately does not delete these nonsensitive
 * records: deletion could turn an explicit revocation into automatic first use. */
export class SharedUnlockLinkStore {
  private tail: Promise<void> = Promise.resolve();
  private readonly pendingWrites = new Map<string, SharedUnlockLinkMarker>();
  constructor(private readonly storage: StorageArea, private readonly newId: () => string = () => crypto.randomUUID()) {}

  read(scope: SharedUnlockLinkScope): Promise<SharedUnlockLinkMarker | null> {
    const selected = { ...scope };
    return this.serial(() => this.load(selected));
  }

  /** Explicit own UI action, including when the peer is absent. Never allocate
   * a link while closing; missing preference/revision is repaired via Identity. */
  recordManualClosing(scope: SharedUnlockLinkScope, action: "lock" | "logout"): Promise<SharedUnlockLinkMarker | null> {
    const selected = { ...scope };
    return this.serial(async () => {
      const marker = this.pendingWrites.get(this.key(selected)) ?? await this.load(selected);
      if (!marker) return null;
      const previous = marker.pending.find(intent => intent.action !== "disconnect");
      const pending = previous?.action === "logout" || previous?.action === action ? marker.pending
        : [{ id: this.newId(), action, expectedRevision: marker.observed?.revision ?? 0, preferenceRevision: null },
          ...marker.pending.filter(intent => intent.action === "disconnect")];
      const updated = { ...marker, pending };
      await this.save(selected, updated);
      return updated;
    });
  }

  /** Allocate once before contacting Identity. A failed/restarted create must
   * reuse this ID, never create a different link to escape an existing barrier. */
  ensure(scope: SharedUnlockLinkScope): Promise<SharedUnlockLinkMarker> {
    const selected = { ...scope };
    return this.serial(async () => {
      const existing = await this.load(selected);
      if (existing) return existing;
      const marker: SharedUnlockLinkMarker = { ...selected, version: 1, linkId: this.newId(), observed: null, pending: [], disconnectId: null };
      await this.save(selected, marker);
      return marker;
    });
  }

  /** Adopt only an exact link chosen through an independently verified browser
   * route. An existing different ID is a conflict, never permission to relink. */
  adopt(scope: SharedUnlockLinkScope, linkId: string): Promise<SharedUnlockLinkMarker> {
    const selected = { ...scope };
    return this.serial(async () => {
      const existing = await this.load(selected);
      if (existing) {
        if (existing.linkId !== linkId) throw new SharedUnlockLinkStorageError();
        return existing;
      }
      const marker: SharedUnlockLinkMarker = { ...selected, version: 1, linkId, observed: null, pending: [], disconnectId: null };
      await this.save(selected, marker);
      return marker;
    });
  }

  observe(scope: SharedUnlockLinkScope, response: SharedUnlockLink): Promise<SharedUnlockLinkMarker> {
    const selected = { ...scope }, received = projectLink(response);
    return this.serial(async () => {
      const marker = await this.require(selected, received.linkId);
      const observed = this.latest(marker.observed, received);
      const updated = { ...marker, observed,
        disconnectId: marker.disconnectId ?? (observed.state === "revoked" ? this.newId() : null) };
      await this.save(selected, updated);
      return updated;
    });
  }

  /** The caller cancels local work before awaiting durable write or network.
   * Logout is stronger than lock; disconnect is a separate retained action. */
  beginClosing(scope: SharedUnlockLinkScope, linkId: string, action: SharedUnlockClosingAction,
    expectedRevision: number, preferenceRevision: number | null): Promise<SharedUnlockLinkMarker> {
    const selected = { ...scope };
    return this.serial(async () => {
      const marker = this.pendingWrites.get(this.key(selected)) ?? await this.require(selected, linkId);
      if (marker.linkId !== linkId) throw new SharedUnlockLinkStorageError();
      const previous = marker.pending.find(intent => action === "disconnect"
        ? intent.action === "disconnect" : intent.action !== "disconnect");
      if (previous && (previous.action === action || previous.action === "logout")) {
        if (this.pendingWrites.has(this.key(selected))) await this.save(selected, marker);
        return marker;
      }
      const next = { id: this.newId(), action, expectedRevision, preferenceRevision };
      const pending = marker.pending.filter(intent => intent !== previous);
      if (action === "disconnect") pending.push(next);
      else pending.unshift(next);
      const updated = { ...marker, pending, disconnectId: action === "disconnect" ? next.id : marker.disconnectId };
      await this.save(selected, updated);
      return updated;
    });
  }

  /** A receipt may settle only its own intent. An old success cannot erase a
   * newer closing decision made while its Identity request was in flight. */
  acknowledgeClosing(scope: SharedUnlockLinkScope, linkId: string, intentId: string,
    response: SharedUnlockLink): Promise<SharedUnlockLinkMarker> {
    const selected = { ...scope }, received = projectLink(response);
    return this.serial(async () => {
      const marker = await this.require(selected, linkId);
      if (received.linkId !== linkId) throw new SharedUnlockLinkStorageError();
      const observed = this.latest(marker.observed, received);
      const updated = { ...marker, observed,
        disconnectId: marker.disconnectId ?? (observed.state === "revoked" ? this.newId() : null),
        pending: marker.pending.filter(intent => intent.id !== intentId) };
      await this.save(selected, updated);
      return updated;
    });
  }

  /** Only a fresh authenticated OFF observation may settle manual propagation
   * without a link mutation. Disconnect is independent and is never removed. */
  acknowledgeDisabledClosing(scope: SharedUnlockLinkScope, linkId: string, intentId: string): Promise<SharedUnlockLinkMarker> {
    const selected = { ...scope };
    return this.serial(async () => {
      const marker = await this.require(selected, linkId);
      const updated = { ...marker, pending: marker.pending.filter(intent => intent.id !== intentId || intent.action === "disconnect") };
      await this.save(selected, updated);
      return updated;
    });
  }

  /** Called only for the receipt of an explicit reconnect. A later disconnect
   * or closing action invalidates this receipt; a background read never clears it. */
  acknowledgeReconnect(scope: SharedUnlockLinkScope, linkId: string, disconnectId: string,
    response: SharedUnlockLink): Promise<SharedUnlockLinkMarker> {
    const selected = { ...scope }, received = projectLink(response);
    return this.serial(async () => {
      const marker = await this.require(selected, linkId);
      if (received.linkId !== linkId || marker.disconnectId !== disconnectId || marker.pending.length
        || (marker.observed && marker.observed.revision > received.revision)) throw new SharedUnlockLinkStorageError();
      const updated = { ...marker, observed: this.latest(marker.observed, received), disconnectId: null };
      await this.save(selected, updated);
      return updated;
    });
  }

  /** Retry the retained exact write; success still leaves closing intent and
   * revocation gates intact for subsequent Identity reconciliation. */
  repair(scope: SharedUnlockLinkScope): Promise<SharedUnlockLinkMarker | null> {
    const selected = { ...scope };
    return this.serial(async () => {
      const marker = this.pendingWrites.get(this.key(selected));
      if (!marker) return this.load(selected);
      await this.save(selected, marker);
      return marker;
    });
  }

  private latest(previous: SharedUnlockLink | null, received: SharedUnlockLink): SharedUnlockLink {
    return previous && received.revision <= previous.revision ? previous : received;
  }
  private key(scope: SharedUnlockLinkScope): string {
    return "palladin.shared-unlock.link.v1:" + JSON.stringify([scope.apiUrl, scope.webOrigin, scope.extensionId, scope.accountId]);
  }
  private async require(scope: SharedUnlockLinkScope, linkId: string): Promise<SharedUnlockLinkMarker> {
    const marker = await this.load(scope);
    if (!marker || marker.linkId !== linkId) throw new SharedUnlockLinkStorageError();
    return marker;
  }
  private async load(scope: SharedUnlockLinkScope): Promise<SharedUnlockLinkMarker | null> {
    const key = this.key(scope);
    if (this.pendingWrites.has(key)) throw new SharedUnlockLinkStorageError();
    const values = await this.storage.get([key]);
    if (!Object.hasOwn(values, key)) return null;
    const parsed = markerSchema.safeParse(values[key]);
    // Local persistent bytes are an independent input boundary. Corruption is
    // not absence: silently replacing it would bypass a saved closing intent.
    if (!parsed.success) throw new SharedUnlockLinkStorageError();
    const marker = parsed.data;
    if (marker.apiUrl !== scope.apiUrl || marker.webOrigin !== scope.webOrigin
      || marker.extensionId !== scope.extensionId || marker.accountId !== scope.accountId
      || (marker.observed && marker.observed.linkId !== marker.linkId)
      || new Set(marker.pending.map(intent => intent.id)).size !== marker.pending.length
      || marker.pending.filter(intent => intent.action !== "disconnect").length > 1
      || marker.pending.filter(intent => intent.action === "disconnect").length > 1) throw new SharedUnlockLinkStorageError();
    return marker;
  }
  private async save(scope: SharedUnlockLinkScope, marker: SharedUnlockLinkMarker): Promise<void> {
    // Explicit projection also keeps future in-memory fields out of persistence.
    const key = this.key(scope);
    this.pendingWrites.set(key, marker);
    await this.storage.set({ [key]: { version: 1, apiUrl: scope.apiUrl, webOrigin: scope.webOrigin,
      extensionId: scope.extensionId, accountId: scope.accountId, linkId: marker.linkId,
      observed: marker.observed ? projectLink(marker.observed) : null, disconnectId: marker.disconnectId,
      pending: marker.pending.map(intent => ({ id: intent.id, action: intent.action, expectedRevision: intent.expectedRevision,
        preferenceRevision: intent.preferenceRevision })) } });
    this.pendingWrites.delete(key);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

function projectLink(value: SharedUnlockLink): SharedUnlockLink {
  return { linkId: value.linkId, revision: value.revision, epoch: value.epoch, state: value.state,
    lastInvalidationSequence: value.lastInvalidationSequence, lastLogoutSequence: value.lastLogoutSequence };
}
