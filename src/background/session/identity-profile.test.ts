import 'fake-indexeddb/auto'
import { generateAccountSecret, IDENTITY_ACCOUNT_SECRET_PROFILE, IDENTITY_KDF_PROFILE, toBase64Url } from '@palladin/crypto'
import { describe, expect, it } from 'vitest'

import { browserAccountSecretDevice, identityProfileVersion, loadDeviceAccountSecret } from './identity-profile'

const ACCOUNT_ID = '00112233-4455-4677-8899-aabbccddeeff'
const SALT = toBase64Url(new Uint8Array(16).fill(1))

describe('Identity KDF profile selection', () => {
  it('derives only the registered password and Secret Key profiles', () => {
    expect(identityProfileVersion({ profileId: IDENTITY_KDF_PROFILE.id, securityVersion: 1, kdfSalt: SALT })).toBe(1)
    expect(identityProfileVersion({ ...IDENTITY_ACCOUNT_SECRET_PROFILE, profileId: IDENTITY_ACCOUNT_SECRET_PROFILE.id, kdfSalt: SALT })).toBe(2)
  })

  it.each([
    ['an unknown newer profile', { profileId: 'identity-argon2id-future-v3', securityVersion: 3, kdfSalt: SALT }],
    ['weakened Argon2id parameters', { profileId: IDENTITY_ACCOUNT_SECRET_PROFILE.id, securityVersion: 2, kdfSalt: SALT, memoryKiB: 1024 }],
    ['a profile id from another version', { profileId: IDENTITY_KDF_PROFILE.id, securityVersion: 2, kdfSalt: SALT }],
  ])('fails closed for %s', (_name, metadata) => {
    expect(() => identityProfileVersion(metadata)).toThrow(expect.objectContaining({ code: 'unsupported-security' }))
  })
})

describe('browser device wrapper for the Secret Key', () => {
  it('round-trips the Secret Key and forgets it on delete', async () => {
    const secret = await generateAccountSecret()
    await browserAccountSecretDevice.store(ACCOUNT_ID, secret)

    expect(await browserAccountSecretDevice.load(ACCOUNT_ID)).toEqual(secret)
    await browserAccountSecretDevice.delete(ACCOUNT_ID)
    expect(await browserAccountSecretDevice.load(ACCOUNT_ID)).toBeNull()
  })

  it('stores ciphertext only, never the raw Secret Key', async () => {
    const secret = await generateAccountSecret()
    await browserAccountSecretDevice.store(ACCOUNT_ID, secret)
    const record = await new Promise<{ ciphertext: ArrayBuffer, key: CryptoKey }>((resolve, reject) => {
      const open = indexedDB.open('palladin-device')
      open.onsuccess = () => {
        const get = open.result.transaction('account-secrets').objectStore('account-secrets').get(ACCOUNT_ID)
        get.onsuccess = () => { open.result.close(); resolve(get.result) }
        get.onerror = () => reject(get.error)
      }
    })

    expect(record.key.extractable).toBe(false)
    expect(Buffer.from(record.ciphertext).includes(Buffer.from(secret))).toBe(false)
    await browserAccountSecretDevice.delete(ACCOUNT_ID)
  })

  it('treats an unreadable wrapper as absent', async () => {
    const failing = { ...browserAccountSecretDevice, load: async () => { throw new Error('device-wrapper-unavailable') } }

    await expect(loadDeviceAccountSecret(failing, ACCOUNT_ID)).resolves.toBeNull()
  })
})
