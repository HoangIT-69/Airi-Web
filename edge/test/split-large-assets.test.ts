import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_ASSET_BYTES, splitLargeAssets } from '../scripts/split-large-assets'

let root: string
const dist = (): string => path.join(root, 'dist')
const large = (): string => path.join(root, 'large')
const manifest = (): string => path.join(root, 'large-assets.json')

async function writeSized(relative: string, bytes: number): Promise<void> {
  const file = path.join(dist(), relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, Buffer.alloc(bytes))
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'split-assets-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('splitLargeAssets', () => {
  it('moves only files above the limit and records their URL paths', async () => {
    await writeSized('assets/big.vrm', MAX_ASSET_BYTES + 1)
    await writeSized('assets/edge.bin', MAX_ASSET_BYTES)
    await writeSized('index.html', 10)

    const moved = await splitLargeAssets(dist(), large(), manifest())

    expect(moved).toEqual(['/assets/big.vrm'])
    expect((await stat(path.join(large(), 'assets/big.vrm'))).size).toBe(MAX_ASSET_BYTES + 1)
    await expect(stat(path.join(dist(), 'assets/big.vrm'))).rejects.toThrow()
    await expect(stat(path.join(dist(), 'assets/edge.bin'))).resolves.toBeDefined()
    expect(JSON.parse(await readFile(manifest(), 'utf8'))).toEqual(['/assets/big.vrm'])
  })

  it('writes an empty manifest when nothing is oversized', async () => {
    await writeSized('index.html', 10)

    expect(await splitLargeAssets(dist(), large(), manifest())).toEqual([])
    expect(JSON.parse(await readFile(manifest(), 'utf8'))).toEqual([])
  })

  it('fails when the dist directory does not exist', async () => {
    await expect(splitLargeAssets(path.join(root, 'missing'), large(), manifest())).rejects.toThrow()
  })
})
