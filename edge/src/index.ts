/**
 * Edge entry for AIRI web on *.workers.dev.
 * - Backend paths are proxied to the EC2 origin with a shared secret header, so the browser
 *   only ever talks to one origin (no CORS, first-party auth cookies).
 * - Static files come from Workers Assets; files over the 25 MiB asset limit come from R2.
 * Access control for the whole host is Cloudflare Access (configured in the dashboard).
 */

// Paths moved to R2 at build time by scripts/split-large-assets.ts.
import largeAssetPaths from './large-assets.json'

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

    if (LARGE_ASSETS.has(pathname))
      return serveLargeAsset(pathname, env)
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
