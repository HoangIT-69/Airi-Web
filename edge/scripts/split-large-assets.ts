/**
 * Moves build files over the Workers Assets size limit out of `dist/` into `large/`
 * (uploaded to R2 by CI) and records their URL paths in `src/large-assets.json`.
 * Usage: node scripts/split-large-assets.ts [distDir] [largeDir] [manifestPath]
 */
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Workers Assets rejects files larger than 25 MiB. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name))
}

export async function splitLargeAssets(distDir: string, largeDir: string, manifestPath: string): Promise<string[]> {
  const moved: string[] = []
  for (const file of await listFiles(distDir)) {
    if ((await stat(file)).size <= MAX_ASSET_BYTES)
      continue
    const relative = path.relative(distDir, file)
    const destination = path.join(largeDir, relative)
    await mkdir(path.dirname(destination), { recursive: true })
    await rename(file, destination)
    moved.push(`/${relative.split(path.sep).join('/')}`)
  }
  moved.sort()
  await writeFile(manifestPath, `${JSON.stringify(moved, null, 2)}\n`)
  return moved
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const [distDir = 'dist', largeDir = 'large', manifestPath = 'src/large-assets.json'] = process.argv.slice(2)
  const moved = await splitLargeAssets(distDir, largeDir, manifestPath)
  process.stdout.write(`${moved.length} file(s) moved to ${largeDir}\n${moved.join('\n')}\n`)
}
