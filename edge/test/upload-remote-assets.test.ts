import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildGlb, parseGlb } from '../scripts/shrink-vrm.ts'
import {
  DEFAULT_SOURCES,
  ensureMobileVrm,
  main,
  planUploads,
  pnpmWrangler,
  putArgs,
  resolveSources,
  type Sources,
  uploadAll,
  verifyAll,
} from '../scripts/upload-remote-assets.ts'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }))

const BUCKET = 'test-bucket'
let root: string
let sources: Sources

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'remote-assets-test-'))
  const motions = path.join(root, 'motions')
  await mkdir(path.join(motions, 'dances'), { recursive: true })
  const files: Record<string, string> = {
    'Arcana.vrm': 'arcana',
    'Arcana.mobile.vrm': 'mobile',
    'c583.zip': 'zip',
    'card.json': '{}',
    'motions/Idle.vrma': 'idle',
    'motions/VRMA_02_greeting.vrma': 'greet',
    'motions/LICENSE-rexclaw': 'license',
    'motions/dances/hip-hop.vrma': 'dance',
  }
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(root, name), content)
  sources = {
    arcana: path.join(root, 'Arcana.vrm'),
    arcanaMobile: path.join(root, 'Arcana.mobile.vrm'),
    c583: path.join(root, 'c583.zip'),
    motions,
    card: path.join(root, 'card.json'),
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('planUploads', () => {
  it('maps every source to its remote-assets key and content type', async () => {
    const plan = await planUploads(sources)

    expect(plan.map(item => [item.key, item.contentType])).toEqual([
      ['remote-assets/models/arcana/Arcana.vrm', 'model/gltf-binary'],
      ['remote-assets/models/arcana/Arcana.mobile.vrm', 'model/gltf-binary'],
      ['remote-assets/models/c583/c583.zip', 'application/zip'],
      ['remote-assets/motions/Idle.vrma', 'model/gltf-binary'],
      ['remote-assets/motions/VRMA_02_greeting.vrma', 'model/gltf-binary'],
      ['remote-assets/motions/dances/hip-hop.vrma', 'model/gltf-binary'],
      ['remote-assets/cards/thu-ky/card.json', 'application/json'],
    ])
    expect(plan[3].file).toBe(path.join(sources.motions, 'Idle.vrma'))
  })

  it('fails when the motions folder is missing', async () => {
    await expect(planUploads({ ...sources, motions: path.join(root, 'nope') })).rejects.toThrow()
  })
})

describe('putArgs', () => {
  it('builds a remote wrangler r2 put with an explicit content type', () => {
    expect(putArgs(BUCKET, { file: 'a.zip', key: 'remote-assets/a.zip', contentType: 'application/zip' })).toEqual([
      'r2',
      'object',
      'put',
      'test-bucket/remote-assets/a.zip',
      '--file',
      'a.zip',
      '--remote',
      '--content-type',
      'application/zip',
    ])
  })
})

describe('uploadAll', () => {
  it('puts every planned file in order', async () => {
    const plan = await planUploads(sources)
    const run = vi.fn((_args: readonly string[]) => 0)

    await uploadAll(BUCKET, plan, run)

    expect(run).toHaveBeenCalledTimes(plan.length)
    expect(run.mock.calls.map(([args]) => args[3])).toEqual(plan.map(item => `${BUCKET}/${item.key}`))
  })

  it('stops at the first failed upload', async () => {
    const plan = await planUploads(sources)
    const run = vi.fn((_args: readonly string[]) => 1)

    await expect(uploadAll(BUCKET, plan, run)).rejects.toThrow('upload failed: remote-assets/models/arcana/Arcana.vrm')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('verifyAll', () => {
  /** Fake `wrangler r2 object get` (synchronous like spawnSync) that writes `bytes(key)` to --file. */
  function fakeGet(bytes: (key: string) => string | undefined) {
    return vi.fn((args: readonly string[]) => {
      const content = bytes(args[3].slice(BUCKET.length + 1))
      if (content === undefined)
        return 1
      writeFileSync(args[5], content)
      return 0
    })
  }

  it('reports no failures when every downloaded size matches', async () => {
    const plan = await planUploads(sources)
    const byKey = new Map(await Promise.all(plan.map(async item => [item.key, await readFile(item.file, 'utf8')] as const)))

    const failures = await verifyAll(BUCKET, plan, fakeGet(key => byKey.get(key)), path.join(root, 'verify'))

    expect(failures).toEqual([])
  })

  it('reports keys that are missing or have the wrong size', async () => {
    const plan = await planUploads(sources)

    const failures = await verifyAll(BUCKET, plan, fakeGet(key => (key.endsWith('.zip') ? 'zip' : key.endsWith('.json') ? undefined : 'wrong size!')), path.join(root, 'verify'))

    expect(failures).toContain('remote-assets/cards/thu-ky/card.json: expected 2 B, got nothing')
    expect(failures).toContain('remote-assets/models/arcana/Arcana.vrm: expected 6 B, got 11')
    expect(failures.some(line => line.includes('c583.zip'))).toBe(false)
  })
})

describe('ensureMobileVrm', () => {
  it('keeps an existing mobile copy untouched', async () => {
    await ensureMobileVrm(sources.arcana, sources.arcanaMobile)

    expect(await readFile(sources.arcanaMobile, 'utf8')).toBe('mobile')
  })

  it('generates a texture-reduced copy when it is missing', async () => {
    const image = new Uint8Array(await sharp({ create: { width: 64, height: 32, channels: 3, background: '#ff0000' } }).png().toBuffer())
    const json = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: image.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: image.byteLength }],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
    }
    await writeFile(sources.arcana, buildGlb({ json, bin: image }))
    const target = path.join(root, 'out', 'Arcana.mobile.vrm')

    await ensureMobileVrm(sources.arcana, target, 16)

    const { json: shrunk, bin } = parseGlb(new Uint8Array(await readFile(target)))
    const view = shrunk.bufferViews![0]
    expect(await sharp(bin.subarray(0, view.byteLength)).metadata()).toMatchObject({ width: 16, height: 8 })
    expect((await stat(target)).size).toBeGreaterThan(0)
  })
})

describe('resolveSources', () => {
  it('prefers CLI values, then env vars, then defaults', () => {
    const resolved = resolveSources({ arcana: 'cli.vrm' }, { REMOTE_ASSETS_ARCANA: 'env.vrm', REMOTE_ASSETS_C583: 'env.zip' })

    expect(resolved).toEqual({ ...DEFAULT_SOURCES, arcana: 'cli.vrm', c583: 'env.zip' })
  })
})

describe('main', () => {
  function cliArgs(...extra: string[]): string[] {
    return ['--arcana', sources.arcana, '--arcana-mobile', sources.arcanaMobile, '--c583', sources.c583, '--motions', sources.motions, '--card', sources.card, ...extra]
  }

  it('lists the plan without calling wrangler on --dry-run', async () => {
    const run = vi.fn((_args: readonly string[]) => 0)
    const lines: string[] = []

    const code = await main(cliArgs('--dry-run'), {}, run, line => lines.push(line))

    expect(code).toBe(0)
    expect(run).not.toHaveBeenCalled()
    expect(lines.at(-1)).toBe('7 file(s) -> r2://airi-web-large-assets')
    expect(lines[0]).toBe('6	model/gltf-binary	remote-assets/models/arcana/Arcana.vrm')
  })

  it('uploads to the bucket from the environment by default', async () => {
    const run = vi.fn((_args: readonly string[]) => 0)

    const code = await main(cliArgs(), { REMOTE_ASSETS_BUCKET: BUCKET }, run, () => {})

    expect(code).toBe(0)
    expect(run).toHaveBeenCalledTimes(7)
    expect(run.mock.calls[0][0].slice(0, 4)).toEqual(['r2', 'object', 'put', `${BUCKET}/remote-assets/models/arcana/Arcana.vrm`])
  })

  it('verifies instead of uploading on --verify and fails on a mismatch', async () => {
    const run = vi.fn((_args: readonly string[]) => 1)
    const lines: string[] = []

    const code = await main(cliArgs('--verify', '--bucket', BUCKET), {}, run, line => lines.push(line))

    expect(code).toBe(1)
    expect(run.mock.calls.every(([args]) => args[2] === 'get')).toBe(true)
    expect(lines.at(-1)).toContain('got nothing')
  })

  it('exits 0 when verification passes', async () => {
    const run = vi.fn((args: readonly string[]) => {
      const key = args[3].slice(BUCKET.length + 1)
      const local = Object.entries({
        'remote-assets/models/arcana/Arcana.vrm': 'arcana',
        'remote-assets/models/arcana/Arcana.mobile.vrm': 'mobile',
        'remote-assets/models/c583/c583.zip': 'zip',
        'remote-assets/motions/Idle.vrma': 'idle',
        'remote-assets/motions/VRMA_02_greeting.vrma': 'greet',
        'remote-assets/motions/dances/hip-hop.vrma': 'dance',
        'remote-assets/cards/thu-ky/card.json': '{}',
      }).find(([name]) => name === key)?.[1] ?? ''
      writeFileSync(args[5], local)
      return 0
    })
    const lines: string[] = []

    const code = await main(cliArgs('--verify', '--bucket', BUCKET), {}, run, line => lines.push(line))

    expect(code).toBe(0)
    expect(lines.at(-1)).toBe('verified 7 key(s)')
  })
})

describe('pnpmWrangler', () => {
  it('runs wrangler through pnpm exec and returns its exit status', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 3 } as ReturnType<typeof spawnSync>)

    const status = pnpmWrangler(['r2', 'object', 'get', 'b/k', '--file', 'C:\with space\f.vrm'])

    expect(status).toBe(3)
    const [command, args, options] = vi.mocked(spawnSync).mock.calls.at(-1)!
    expect(command).toBe('pnpm')
    expect(args?.slice(0, 3)).toEqual(['exec', 'wrangler', 'r2'])
    const fileArg = args?.at(-1)
    expect(fileArg).toBe(options?.shell ? '"C:\with space\f.vrm"' : 'C:\with space\f.vrm')
  })

  it('treats a missing exit status as failure', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: null } as ReturnType<typeof spawnSync>)

    expect(pnpmWrangler(['--version'])).toBe(1)
  })
})
