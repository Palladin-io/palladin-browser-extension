import { describe, expect, it } from 'vitest'

import negativeFixtures from './fixtures/current-member-entry-sync-v2/negative/rejections.json'
import tombstoneResetFixture from './fixtures/current-member-entry-sync-v2/vectors/tombstone-reset.json'
import validSnapshotFixture from './fixtures/current-member-entry-sync-v2/vectors/valid-snapshot.json'
import { deltaSchema, resetSchema, snapshotSchema } from './contracts'

interface NegativeFixtureCase {
  readonly id: string
  readonly expectedError: string
  readonly fixture: unknown
}

const negativeCases = (negativeFixtures as { cases: NegativeFixtureCase[] }).cases

describe('frozen Current Entry Sync Policy 2 consumer contract', () => {
  it('parses the complete snapshot, terminal tombstone delta and reset controls', () => {
    const valid = validSnapshotFixture as { response: unknown }
    const controls = tombstoneResetFixture as {
      tombstoneDelta: { response: unknown }
      reset: { response: unknown }
    }

    expect(snapshotSchema.safeParse(valid.response).success).toBe(true)
    expect(deltaSchema.safeParse(controls.tombstoneDelta.response).success).toBe(true)
    expect(resetSchema.safeParse(controls.reset.response).success).toBe(true)
  })

  it.each([
    'missing-member-secret',
    'member-secret-revision-mismatch',
    'member-secret-vault-substitution',
    'member-index-generation-substitution',
    'head-key-version-substitution',
  ])('rejects the independently malformed complete head: %s', (id) => {
    const fixture = negativeCases.find((candidate) => candidate.id === id)?.fixture
    expect(fixture).toBeDefined()
    expect(snapshotSchema.safeParse(fixture).success).toBe(false)
  })

  it.each([
    'access-context-principal-substitution',
    'coordinated-member-generation-substitution',
    'coordinated-vault-key-version-substitution',
    'offline-access-exact-expiry',
    'offline-access-duration-exceeds-policy',
  ])('leaves internally consistent %s for the runtime independent-authority gate', (id) => {
    const fixture = negativeCases.find((candidate) => candidate.id === id)?.fixture
    expect(fixture).toBeDefined()
    expect(snapshotSchema.safeParse(fixture).success).toBe(true)
  })
})
