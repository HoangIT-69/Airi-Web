import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env, isBackendPath, ORIGIN_AUTH_HEADER } from '../src/index'

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
