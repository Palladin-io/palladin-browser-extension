import { VaultDataError } from '../errors'

interface VaultKeyEpochSource {
  readonly id: string
  readonly memberKeyGeneration: number
  readonly currentKeyEpoch: { readonly vaultKeyVersion: number }
}

interface VaultKeyEpoch {
  readonly vaultKeyVersion: number
  readonly memberKeyGeneration: number
}

/**
 * Highest Vault key epoch opened per account and Vault in this unlocked
 * session. The server names the epoch in every projection, so only client
 * state can reject a replayed older projection whose retired Vault key a
 * removed member may still hold. Memory-only by design; cleared on lock.
 */
export class VaultKeyEpochFloor {
  private readonly floors = new Map<string, VaultKeyEpoch>()
  private session = 0

  /** Rejects a projection below the floor before its key is opened, then raises the floor. */
  async openForWrite<T>(userId: string, vault: VaultKeyEpochSource, open: () => Promise<T>): Promise<T> {
    this.assertCurrent(userId, vault)
    return this.observe(userId, vault, open)
  }

  /**
   * Another operation may raise the floor while a write awaits, so writes
   * call this again immediately before sealing and before submitting.
   */
  assertCurrent(userId: string, vault: VaultKeyEpochSource): void {
    const floor = this.floors.get(floorKey(userId, vault.id))
    if (floor && (vault.currentKeyEpoch.vaultKeyVersion < floor.vaultKeyVersion
      || vault.memberKeyGeneration < floor.memberKeyGeneration)) {
      throw new VaultDataError('decrypt-failed', 'Vault key epoch rollback')
    }
  }

  /** Raises the floor only after the projection's wrapper opened successfully. */
  async observe<T>(userId: string, vault: VaultKeyEpochSource, open: () => Promise<T>): Promise<T> {
    const session = this.session
    const opened = await open()
    // An open that started before lock must not seed the next session's floor.
    if (session !== this.session) return opened
    const key = floorKey(userId, vault.id)
    const floor = this.floors.get(key)
    this.floors.set(key, {
      vaultKeyVersion: Math.max(floor?.vaultKeyVersion ?? 0, vault.currentKeyEpoch.vaultKeyVersion),
      memberKeyGeneration: Math.max(floor?.memberKeyGeneration ?? 0, vault.memberKeyGeneration),
    })
    return opened
  }

  clear(): void {
    this.session += 1
    this.floors.clear()
  }
}

function floorKey(userId: string, vaultId: string): string {
  return `${userId}:${vaultId}`
}
