import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { contentTypeFor, type Env, isBackendPath, isRemoteAssetPath, ORIGIN_AUTH_HEADER, parseRange } from '../src/index'

vi.mock('../src/large-assets.json', () => ({ default: ['/assets/AvatarSample_A-abc.vrm'] }))

const ORIGIN = 'https://1-2-3-4.sslip.io'
const SECRET = 'origin-secret'
const HOST = 'airi-web.example.workers.dev'

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: vi.fn(async () => new Response('asset', { status: 200 })) } as unknown as Fetcher,
    LARGE_ASSETS: { get: vi.fn(async () => null) } as unknown as R2Bucket,
    ORIGIN_URL: ORIGIN,
    ORIGIN_SECRET: SECRET,
    ...overrides,
  }
}

function call(path: string, env: Env, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://${HOST}${path}`, init), env)
}

function stubOrigin(response: () => Response) {
  const fetchMock = vi.fn(async (_request: Request) => response())
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isBackendPath', () => {
  it.each(['/api', '/api/v1/chats', '/auth', '/auth/callback', '/ws/chat', '/.well-known/openid'])(
    'routes %s to the origin',
    (path) => {
      expect(isBackendPath(path)).toBe(true)
    },
  )

  it.each(['/', '/apidocs', '/authors', '/assets/app.js', '/settings', ''])('serves %j from assets', (path) => {
    expect(isBackendPath(path)).toBe(false)
  })
})

describe('worker.fetch backend proxy', () => {
  it('forwards method, path, query and body to the origin with the secret header', async () => {
    const fetchMock = stubOrigin(() => new Response('ok', { status: 201 }))

    const response = await call('/api/v1/chats?limit=5', makeEnv(), { method: 'POST', body: '{"a":1}' })

    expect(response.status).toBe(201)
    const forwarded = fetchMock.mock.calls[0][0]
    expect(forwarded.url).toBe(`${ORIGIN}/api/v1/chats?limit=5`)
    expect(forwarded.method).toBe('POST')
    expect(forwarded.headers.get(ORIGIN_AUTH_HEADER)).toBe(SECRET)
    expect(forwarded.headers.get('X-Forwarded-Host')).toBe(HOST)
    expect(await forwarded.text()).toBe('{"a":1}')
  })

  it('overwrites a client-supplied origin secret header', async () => {
    const fetchMock = stubOrigin(() => new Response('ok'))

    await call('/auth/session', makeEnv(), { headers: { [ORIGIN_AUTH_HEADER]: 'forged' } })

    expect(fetchMock.mock.calls[0][0].headers.get(ORIGIN_AUTH_HEADER)).toBe(SECRET)
  })

  it('does not follow origin redirects so auth Location headers reach the browser', async () => {
    const fetchMock = stubOrigin(() => new Response(null, { status: 302, headers: { Location: '/x' } }))

    const response = await call('/api/auth/sign-in', makeEnv())

    expect(fetchMock.mock.calls[0][0].redirect).toBe('manual')
    expect(response.status).toBe(302)
  })

  it('returns 502 without leaking details when the origin is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ETIMEDOUT 1.2.3.4:443')
    }))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await call('/api/v1/chats', makeEnv())

    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('1.2.3.4')
  })

  it.each([
    ['missing origin url', { ORIGIN_URL: '' }],
    ['plain http origin', { ORIGIN_URL: 'http://1-2-3-4.sslip.io' }],
    ['missing secret', { ORIGIN_SECRET: '' }],
  ])('refuses to proxy with %s', async (_label, overrides) => {
    const fetchMock = stubOrigin(() => new Response('ok'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await call('/api/v1/chats', makeEnv(overrides))

    expect(response.status).toBe(502)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('worker.fetch static assets', () => {
  it('serves regular paths from Workers Assets', async () => {
    const env = makeEnv()

    const response = await call('/settings', env)

    expect(await response.text()).toBe('asset')
    expect(env.LARGE_ASSETS.get).not.toHaveBeenCalled()
  })

  it('serves files listed in the manifest from R2 with immutable caching', async () => {
    const object = {
      body: 'vrm-bytes',
      httpEtag: '"etag"',
      writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'model/gltf-binary'),
    }
    const env = makeEnv({ LARGE_ASSETS: { get: vi.fn(async () => object) } as unknown as R2Bucket })

    const response = await call('/assets/AvatarSample_A-abc.vrm', env)

    expect(env.LARGE_ASSETS.get).toHaveBeenCalledWith('assets/AvatarSample_A-abc.vrm')
    expect(response.headers.get('Cache-Control')).toContain('immutable')
    expect(response.headers.get('Content-Type')).toBe('model/gltf-binary')
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it('returns 404 when a manifest file is missing from R2', async () => {
    const response = await call('/assets/AvatarSample_A-abc.vrm', makeEnv())

    expect(response.status).toBe(404)
  })
})

const REMOTE_BYTES = new TextEncoder().encode('0123456789')

interface StoredObject { readonly bytes: Uint8Array, readonly contentType?: string }

/** Minimal in-memory R2 bucket covering head() and get() with an { offset, length } range. */
function fakeBucket(objects: Record<string, StoredObject>) {
  const describeObject = (key: string, stored: StoredObject) => ({
    key,
    size: stored.bytes.byteLength,
    httpEtag: `"etag-${key}"`,
    httpMetadata: stored.contentType ? { contentType: stored.contentType } : {},
    writeHttpMetadata: (headers: Headers) => {
      if (stored.contentType)
        headers.set('Content-Type', stored.contentType)
    },
  })
  return {
    head: vi.fn(async (key: string) => (objects[key] ? describeObject(key, objects[key]) : null)),
    get: vi.fn(async (key: string, options?: { range?: { offset: number, length: number } }) => {
      const stored = objects[key]
      if (!stored)
        return null
      const { offset = 0, length = stored.bytes.byteLength } = options?.range ?? {}
      return { ...describeObject(key, stored), body: stored.bytes.slice(offset, offset + length) }
    }),
  }
}

const ARCANA_KEY = 'remote-assets/models/arcana/Arcana.vrm'

function remoteEnv(objects: Record<string, StoredObject> = { [ARCANA_KEY]: { bytes: REMOTE_BYTES } }) {
  const bucket = fakeBucket(objects)
  return { env: makeEnv({ LARGE_ASSETS: bucket as unknown as R2Bucket }), bucket }
}

describe('isRemoteAssetPath', () => {
  it.each(['/remote-assets/models/a.vrm', '/remote-assets/x'])('matches %s', (path) => {
    expect(isRemoteAssetPath(path)).toBe(true)
  })

  it.each(['/remote-assets/', '/remote-assets', '/remote-assetsx/a', '/assets/remote-assets/a'])('ignores %s', (path) => {
    expect(isRemoteAssetPath(path)).toBe(false)
  })
})

describe('contentTypeFor', () => {
  it.each([
    ['models/Arcana.vrm', 'model/gltf-binary'],
    ['motions/Idle.VRMA', 'model/gltf-binary'],
    ['models/c583/c583.zip', 'application/zip'],
    ['cards/thu-ky/card.json', 'application/json'],
    ['blob.bin', 'application/octet-stream'],
    ['no-extension', 'application/octet-stream'],
  ])('maps %s to %s', (key, type) => {
    expect(contentTypeFor(key)).toBe(type)
  })
})

describe('parseRange', () => {
  it.each([
    ['bytes=0-3', 10, { offset: 0, length: 4 }],
    ['bytes=5-', 10, { offset: 5, length: 5 }],
    ['bytes=8-100', 10, { offset: 8, length: 2 }],
    ['bytes=-3', 10, { offset: 7, length: 3 }],
    ['bytes=-50', 10, { offset: 0, length: 10 }],
    ['bytes=9-9', 10, { offset: 9, length: 1 }],
  ])('resolves %s against size %i', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected)
  })

  it.each([null, '', 'bytes=-', 'bytes=0-1,4-5', 'items=0-1', 'bytes=a-b'])('ignores %j', (header) => {
    expect(parseRange(header, 10)).toBeUndefined()
  })

  it.each([['bytes=10-', 10], ['bytes=5-2', 10], ['bytes=-0', 10], ['bytes=-1', 0], ['bytes=0-', 0]] as const)(
    'rejects %s against size %i as unsatisfiable',
    (header, size) => {
      expect(parseRange(header, size)).toBeNull()
    },
  )
})

describe('worker.fetch remote assets', () => {
  it('serves an R2 object with type, length, etag and day-long caching', async () => {
    const { env, bucket } = remoteEnv()

    const response = await call(`/${ARCANA_KEY}`, env)

    expect(response.status).toBe(200)
    expect(bucket.get).toHaveBeenCalledWith(ARCANA_KEY, undefined)
    expect(response.headers.get('Content-Type')).toBe('model/gltf-binary')
    expect(response.headers.get('Content-Length')).toBe('10')
    expect(response.headers.get('ETag')).toBe(`"etag-${ARCANA_KEY}"`)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(await response.text()).toBe('0123456789')
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it('returns 404 instead of the SPA fallback when the object is missing', async () => {
    const { env } = remoteEnv({})

    const response = await call('/remote-assets/models/missing.vrm', env)

    expect(response.status).toBe(404)
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it('returns 404 for a malformed percent-encoded path', async () => {
    const { env, bucket } = remoteEnv()

    const response = await call('/remote-assets/models/%E0%A4%A.vrm', env)

    expect(response.status).toBe(404)
    expect(bucket.head).not.toHaveBeenCalled()
  })

  it('decodes percent-encoded file names into the R2 key', async () => {
    const { env } = remoteEnv({ 'remote-assets/motions/Idle Loop.vrma': { bytes: REMOTE_BYTES } })

    const response = await call('/remote-assets/motions/Idle%20Loop.vrma', env)

    expect(response.status).toBe(200)
  })

  it('answers HEAD with headers only and never downloads the body', async () => {
    const { env, bucket } = remoteEnv()

    const response = await call(`/${ARCANA_KEY}`, env, { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('10')
    expect(response.body).toBeNull()
    expect(bucket.get).not.toHaveBeenCalled()
  })

  it('serves a single byte range with 206 and Content-Range', async () => {
    const { env, bucket } = remoteEnv()

    const response = await call(`/${ARCANA_KEY}`, env, { headers: { Range: 'bytes=2-5' } })

    expect(response.status).toBe(206)
    expect(bucket.get).toHaveBeenCalledWith(ARCANA_KEY, { range: { offset: 2, length: 4 } })
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10')
    expect(response.headers.get('Content-Length')).toBe('4')
    expect(await response.text()).toBe('2345')
  })

  it('answers a ranged HEAD with 206 headers', async () => {
    const { env } = remoteEnv()

    const response = await call(`/${ARCANA_KEY}`, env, { method: 'HEAD', headers: { Range: 'bytes=-4' } })

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 6-9/10')
  })

  it('returns 416 for a range past the end of the object', async () => {
    const { env, bucket } = remoteEnv()

    const response = await call(`/${ARCANA_KEY}`, env, { headers: { Range: 'bytes=10-20' } })

    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */10')
    expect(bucket.get).not.toHaveBeenCalled()
  })

  it('serves the full object when the range header has multiple ranges', async () => {
    const { env } = remoteEnv()

    const response = await call(`/${ARCANA_KEY}`, env, { headers: { Range: 'bytes=0-1,3-4' } })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('0123456789')
  })

  it.each([
    ['remote-assets/motions/dances/Dance.vrma', 'model/gltf-binary'],
    ['remote-assets/models/c583/c583.zip', 'application/zip'],
    ['remote-assets/cards/thu-ky/card.json', 'application/json'],
  ])('derives the content type of %s from its extension', async (key, type) => {
    const { env } = remoteEnv({ [key]: { bytes: REMOTE_BYTES } })

    const response = await call(`/${key}`, env)

    expect(response.headers.get('Content-Type')).toBe(type)
  })

  it('prefers the content type stored with the object', async () => {
    const { env } = remoteEnv({ 'remote-assets/cards/a.json': { bytes: REMOTE_BYTES, contentType: 'application/json; charset=utf-8' } })

    const response = await call('/remote-assets/cards/a.json', env)

    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
  })

  it('rejects methods other than GET and HEAD', async () => {
    const { env, bucket } = remoteEnv()

    const response = await call(`/${ARCANA_KEY}`, env, { method: 'PUT', body: 'x' })

    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('GET, HEAD')
    expect(bucket.head).not.toHaveBeenCalled()
  })

  it('returns 404 when the object disappears between head and get', async () => {
    const { env, bucket } = remoteEnv()
    bucket.get.mockResolvedValueOnce(null)

    const response = await call(`/${ARCANA_KEY}`, env)

    expect(response.status).toBe(404)
  })
})
