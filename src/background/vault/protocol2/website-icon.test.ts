import { afterEach, describe, expect, it, vi } from 'vitest'
import { Protocol2VaultClient } from './client'

const asset = { id: '11111111-1111-4111-8111-111111111111', revision: 2, url: 'https://storage.example.com/icon.png' }
const ready = (hostname = 'www.reddit.com') => Response.json({ items: [{ hostname, status: 'ready', asset }] })

afterEach(() => vi.useRealTimers())

describe('website icon catalog lookup', () => {
  it('sends only the exact normalized host to the selected API, including its base path', async () => {
    const fetch = vi.fn(async () => ready())
    const client = new Protocol2VaultClient(fetch, 'https://self-hosted.example/palladin')
    expect(await client.resolveWebsiteIcon('token', 'https://WWW.REDDIT.COM./register?private=value#fragment'))
      .toEqual({ kind: 'publicAsset', assetId: asset.id, revision: 2, url: asset.url })
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://self-hosted.example/palladin/api/public-assets/website-icons/ensure',
      expect.objectContaining({ body: JSON.stringify({ hostnames: ['www.reddit.com'] }), redirect: 'error',
        credentials: 'omit', referrerPolicy: 'no-referrer' }))
  })

  it('waits for a queued icon instead of permanently saving the first pending result', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ items: [{ hostname: 'www.reddit.com', status: 'pending', asset: null }] }))
      .mockImplementation(async () => ready())
    const result = new Protocol2VaultClient(fetch, 'https://api.example.com').resolveWebsiteIcon('token', 'www.reddit.com')
    await vi.advanceTimersByTimeAsync(500)
    expect(await result).toMatchObject({ assetId: asset.id })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['localhost', 'printer.local', '127.0.0.1', '[::1]', 'invalid_host.example'])('does not send private or invalid host %s', async host => {
    const fetch = vi.fn()
    expect(await new Protocol2VaultClient(fetch, 'https://api.example.com').resolveWebsiteIcon('token', host)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([Response.json({ items: [{ hostname: 'www.reddit.com', status: 'failed', asset: null }] }),
    Response.json({}, { status: 503 }), ready('other.example.com')])('allows credential saving without an available icon', async response => {
    expect(await new Protocol2VaultClient(async () => response, 'https://api.example.com')
      .resolveWebsiteIcon('token', 'www.reddit.com')).toBeNull()
  })

  it('bounds a pending queue so a password can still be saved', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => Response.json({ items: [{ hostname: 'www.reddit.com', status: 'pending', asset: null }] }))
    const result = new Protocol2VaultClient(fetch, 'https://api.example.com').resolveWebsiteIcon('token', 'www.reddit.com')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(10)
  })

  it('aborts a stalled request', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const result = new Protocol2VaultClient(fetch, 'https://api.example.com').resolveWebsiteIcon('token', 'www.reddit.com')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toBeNull()
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('preserves the caller authentication refresh path', async () => {
    const client = new Protocol2VaultClient(async () => new Response(null, { status: 401 }), 'https://api.example.com')
    await expect(client.resolveWebsiteIcon('expired', 'www.reddit.com')).rejects.toMatchObject({ code: 'unauthorized' })
  })
})
