import { describe, expect, it, vi } from 'vitest'
import { isLiveCredentialDocument } from './credential-document'

const source = { tabId: 1, browserDocumentId: 'browser-document', documentId: 'a'.repeat(32), url: 'https://accounts.example.com/login' }

describe('capture document authority without tabs permission', () => {
  it('binds the fresh isolated URL to both document identifiers, without tabs.get', async () => {
    const send = vi.fn().mockResolvedValue({ documentId: source.documentId, url: 'https://accounts.example.com/success' })
    expect(await isLiveCredentialDocument(source, () => source.browserDocumentId, send)).toBe(true)
    expect(send).toHaveBeenCalledWith(1, { channel: 'palladin.tab/current-url' }, { documentId: source.browserDocumentId })
  })
  it.each(['origin', 'http', 'isolated-document', 'browser-document', 'closed', 'payload'])(
    'rejects a changed %s', async (reason) => {
      let live = source.browserDocumentId
      const send = vi.fn(async () => {
        if (reason === 'closed') throw new Error('No document')
        if (reason === 'browser-document') live = 'replacement'
        return { documentId: reason === 'isolated-document' ? 'b'.repeat(32) : source.documentId,
          url: reason === 'origin' ? 'https://other.example.com' : reason === 'http' ? 'http://accounts.example.com' : source.url,
          ...(reason === 'payload' ? { password: 'not-allowed' } : {}) }
      })
      expect(await isLiveCredentialDocument(source, () => live, send)).toBe(false)
    },
  )
  it('rejects an already stale browser document before messaging', async () => {
    const send = vi.fn()
    expect(await isLiveCredentialDocument(source, () => null, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
