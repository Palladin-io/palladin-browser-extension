import { describe, expect, it } from 'vitest'
import { hasVaultManagePermission } from './permissions'

const token = (permissions: unknown) => `header.${btoa(JSON.stringify({ permissions }))}.signature`
describe('capture writable-vault presentation', () => {
  it('reads the backend VaultManage bit from numeric and string claims', () => {
    expect(hasVaultManagePermission(token(8))).toBe(true)
    expect(hasVaultManagePermission(token('12'))).toBe(true)
    expect(hasVaultManagePermission(token(4))).toBe(false)
    expect(hasVaultManagePermission(token('0'))).toBe(false)
  })
  it.each([null, '', 'invalid', token('eight'), token(null), token(-1), token({ value: 8 })])('fails closed for %s', (value) => {
    expect(hasVaultManagePermission(value)).toBe(false)
  })
})
