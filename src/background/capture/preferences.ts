import type { AutomaticUpdateBinding, CredentialCapturePreferences } from "./credential-coordinator";

export const CAPTURE_PREFERENCES_KEY = "palladin.capture-preferences.v1";
const MAX_PROFILES = 20;
const MAX_SETTINGS_PER_PROFILE = 1_000;

export interface CapturePreferenceProfile {
  readonly profileId: string;
  readonly mutedSites: readonly string[];
  readonly automaticUpdates: readonly AutomaticUpdateBinding[];
}

interface CapturePreferenceStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function binding(value: unknown): value is AutomaticUpdateBinding {
  return record(value) && bounded(value.vaultId) && bounded(value.entryId)
    && typeof value.revision === "string" && /^[1-9][0-9]{0,19}$/.test(value.revision)
    && typeof value.origin === "string" && value.origin.length <= 2048
    && /^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(value.origin);
}

function cleanBinding(value: AutomaticUpdateBinding): AutomaticUpdateBinding {
  return { vaultId: value.vaultId, entryId: value.entryId, revision: value.revision, origin: value.origin };
}

function sameEntry(left: AutomaticUpdateBinding, right: Pick<AutomaticUpdateBinding, "vaultId" | "entryId">): boolean {
  return left.vaultId === right.vaultId && left.entryId === right.entryId;
}

export class CapturePreferenceStore implements CredentialCapturePreferences {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: CapturePreferenceStorage) {}

  async getProfile(profileId: string): Promise<CapturePreferenceProfile> {
    await this.tail;
    return (await this.read()).find((profile) => profile.profileId === profileId)
      ?? { profileId, mutedSites: [], automaticUpdates: [] };
  }

  async isMuted(profileId: string, site: string): Promise<boolean> {
    return (await this.getProfile(profileId)).mutedSites.includes(site);
  }

  mute(profileId: string, site: string): Promise<void> {
    return this.change(profileId, (profile) => ({ ...profile,
      mutedSites: [...new Set([...profile.mutedSites, site])].slice(-MAX_SETTINGS_PER_PROFILE) }));
  }

  unmute(profileId: string, site: string): Promise<void> {
    return this.change(profileId, (profile) => ({ ...profile, mutedSites: profile.mutedSites.filter((candidate) => candidate !== site) }));
  }

  async isAutomatic(profileId: string, expected: AutomaticUpdateBinding): Promise<boolean> {
    return (await this.getProfile(profileId)).automaticUpdates.some((candidate) => sameEntry(candidate, expected)
      && candidate.origin === expected.origin && candidate.revision === expected.revision);
  }

  setAutomatic(profileId: string, value: AutomaticUpdateBinding, enabled: boolean): Promise<void> {
    return this.change(profileId, (profile) => {
      const automaticUpdates = profile.automaticUpdates.filter((candidate) => !sameEntry(candidate, value));
      if (enabled && binding(value)) automaticUpdates.push(cleanBinding(value));
      return { ...profile, automaticUpdates: automaticUpdates.slice(-MAX_SETTINGS_PER_PROFILE) };
    });
  }

  disableAutomatic(profileId: string, vaultId: string, entryId: string): Promise<void> {
    return this.change(profileId, (profile) => ({ ...profile,
      automaticUpdates: profile.automaticUpdates.filter((candidate) => !sameEntry(candidate, { vaultId, entryId })) }));
  }

  private change(profileId: string, update: (profile: CapturePreferenceProfile) => CapturePreferenceProfile): Promise<void> {
    const operation = this.tail.then(async () => {
      const profiles = await this.read();
      const previous = profiles.find((profile) => profile.profileId === profileId)
        ?? { profileId, mutedSites: [], automaticUpdates: [] };
      const next = [...profiles.filter((profile) => profile.profileId !== profileId), update(previous)].slice(-MAX_PROFILES);
      await this.storage.set({ [CAPTURE_PREFERENCES_KEY]: next });
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private async read(): Promise<CapturePreferenceProfile[]> {
    const raw = (await this.storage.get([CAPTURE_PREFERENCES_KEY]))[CAPTURE_PREFERENCES_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.slice(-MAX_PROFILES).flatMap((profile): CapturePreferenceProfile[] => {
      if (!record(profile) || !bounded(profile.profileId)) return [];
      return [{ profileId: profile.profileId,
        mutedSites: Array.isArray(profile.mutedSites)
          ? profile.mutedSites.filter((site): site is string => typeof site === "string" && /^[a-z0-9.-]{1,253}$/.test(site)).slice(-MAX_SETTINGS_PER_PROFILE) : [],
        automaticUpdates: Array.isArray(profile.automaticUpdates)
          ? profile.automaticUpdates.filter(binding).map(cleanBinding).slice(-MAX_SETTINGS_PER_PROFILE) : [],
      }];
    });
  }
}
