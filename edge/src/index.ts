/**
 * Edge entry for AIRI web on *.workers.dev.
 * - Backend paths are proxied to the EC2 origin with a shared secret header, so the browser
 *   only ever talks to one origin (no CORS, first-party auth cookies).
 * - Static files come from Workers Assets; files over the 25 MiB asset limit come from R2.
 * - /remote-assets/* (user-uploaded models, motions, cards) come straight from R2, see
 *   scripts/upload-remote-assets.ts.
 * Access control for the whole host is Cloudflare Access (configured in the dashboard).
 */

// Paths moved to R2 at build time by scripts/split-large-assets.ts.
import largeAssetPaths from './large-assets.json'
import { contentTypeFor } from './content-types.ts'

export { contentTypeFor }

export interface Env {
  readonly ASSETS: Fetcher
  readonly LARGE_ASSETS: R2Bucket
  readonly ORIGIN_URL: string
  readonly ORIGIN_SECRET: string
}

export const ORIGIN_AUTH_HEADER = 'X-Origin-Auth'
const BACKEND_PREFIXES = ['/api', '/auth', '/ws', '/.well-known'] as const
const LARGE_ASSETS = new Set<string>(largeAssetPaths)
const NOT_FOUND_STATUS = 404
const BAD_GATEWAY_STATUS = 502
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
const REMOTE_ASSETS_PREFIX = '/remote-assets/'
// Not immutable: remote assets keep their URL when re-uploaded.
const REMOTE_ASSET_CACHE = 'public, max-age=86400'
const PARTIAL_CONTENT_STATUS = 206
const METHOD_NOT_ALLOWED_STATUS = 405
const RANGE_NOT_SATISFIABLE_STATUS = 416

export function isBackendPath(pathname: string): boolean {
  return BACKEND_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function assertConfigured(env: Env): void {
  if (!env.ORIGIN_URL?.startsWith('https://'))
    throw new Error('ORIGIN_URL must be an https URL')
  if (!env.ORIGIN_SECRET)
    throw new Error('ORIGIN_SECRET is not set')
}

export async function proxyToOrigin(request: Request, env: Env): Promise<Response> {
  assertConfigured(env)
  const url = new URL(request.url)
  const target = new URL(`${url.pathname}${url.search}`, env.ORIGIN_URL)

  const headers = new Headers(request.headers)
  headers.set(ORIGIN_AUTH_HEADER, env.ORIGIN_SECRET)
  headers.set('X-Forwarded-Host', url.host)
  headers.set('X-Forwarded-Proto', 'https')

  // Cloning from the original request keeps method, body stream and WebSocket upgrade intact.
  return fetch(new Request(target, new Request(request, { headers, redirect: 'manual' })))
}

async function serveLargeAsset(pathname: string, env: Env): Promise<Response> {
  const object = await env.LARGE_ASSETS.get(pathname.slice(1))
  if (!object)
    return new Response('Not found', { status: NOT_FOUND_STATUS })
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('ETag', object.httpEtag)
  headers.set('Cache-Control', IMMUTABLE_CACHE)
  return new Response(object.body, { headers })
}

export function isRemoteAssetPath(pathname: string): boolean {
  return pathname.startsWith(REMOTE_ASSETS_PREFIX) && pathname.length > REMOTE_ASSETS_PREFIX.length
}

/** A single byte range resolved against the object size; `null` = unsatisfiable. */
export interface ByteRange { readonly offset: number, readonly length: number }

/**
 * Parses a single `bytes=` range (RFC 9110 §14.1.2). Returns `undefined` when the header should be
 * ignored (absent, malformed or multi-range) so the full object is served instead.
 */
export function parseRange(header: string | null, size: number): ByteRange | null | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (match[1] === '' && match[2] === ''))
    return undefined
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (suffix === 0 || size === 0)
      return null
    const length = Math.min(suffix, size)
    return { offset: size - length, length }
  }
  const start = Number(match[1])
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  if (start >= size || end < start)
    return null
  return { offset: start, length: end - start + 1 }
}

function remoteAssetHeaders(key: string, object: R2Object): Headers {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  if (!object.httpMetadata?.contentType)
    headers.set('Content-Type', contentTypeFor(key))
  headers.set('ETag', object.httpEtag)
  headers.set('Cache-Control', REMOTE_ASSET_CACHE)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Content-Length', String(object.size))
  return headers
}

/** R2 key for a remote-asset URL path; `undefined` when the percent-encoding is malformed. */
function decodeKey(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname.slice(1))
  }
  catch {
    return undefined
  }
}

async function serveRemoteAsset(request: Request, pathname: string, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method not allowed', { status: METHOD_NOT_ALLOWED_STATUS, headers: { Allow: 'GET, HEAD' } })

  const key = decodeKey(pathname)
  const meta = key === undefined ? null : await env.LARGE_ASSETS.head(key)
  if (!meta)
    return new Response('Not found', { status: NOT_FOUND_STATUS })

  const headers = remoteAssetHeaders(meta.key, meta)
  const range = parseRange(request.headers.get('Range'), meta.size)
  if (range === null) {
    headers.set('Content-Range', `bytes */${meta.size}`)
    headers.delete('Content-Length')
    return new Response(null, { status: RANGE_NOT_SATISFIABLE_STATUS, headers })
  }
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`)
    headers.set('Content-Length', String(range.length))
  }
  const status = range ? PARTIAL_CONTENT_STATUS : 200
  if (request.method === 'HEAD')
    return new Response(null, { status, headers })

  const object = await env.LARGE_ASSETS.get(meta.key, range ? { range } : undefined)
  if (!object)
    return new Response('Not found', { status: NOT_FOUND_STATUS })
  return new Response(object.body, { status, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (isBackendPath(pathname)) {
      try {
        return await proxyToOrigin(request, env)
      }
      catch (error) {
        console.error('origin proxy failed', error instanceof Error ? error.message : 'unknown error')
        return new Response('Bad gateway', { status: BAD_GATEWAY_STATUS })
      }
    }

    if (isRemoteAssetPath(pathname))
      return serveRemoteAsset(request, pathname, env)
    if (LARGE_ASSETS.has(pathname))
      return serveLargeAsset(pathname, env)
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
