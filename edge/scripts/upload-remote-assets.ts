/**
 * Uploads the owner's own models, motions and character card to R2 under `remote-assets/`,
 * where the Worker serves them as built-in presets. These files are copyrighted: they never go
 * into git. The mobile Arcana is generated with shrink-vrm.ts when no `--arcana-mobile` is given.
 * Usage: node scripts/upload-remote-assets.ts [--dry-run] [--verify] [--bucket <name>]
 *          [--arcana <vrm>] [--arcana-mobile <vrm>] [--c583 <zip>] [--motions <dir>] [--card <json>]
 * Each path option falls back to an env var (REMOTE_ASSETS_ARCANA, ..._ARCANA_MOBILE, ..._C583,
 * ..._MOTIONS, ..._CARD, ..._BUCKET), then to the defaults below.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { contentTypeFor } from '../src/content-types.ts'
import { DEFAULT_MAX_TEXTURE_SIZE, shrinkGlb } from './shrink-vrm.ts'

export const KEY_PREFIX = 'remote-assets'
export const DEFAULT_BUCKET = 'airi-web-large-assets'
const MOTION_EXTENSION = '.vrma'
const DANCES_DIR = 'dances'

export interface Sources {
  readonly arcana: string
  readonly arcanaMobile: string
  readonly c583: string
  readonly motions: string
  readonly card: string
}

export const DEFAULT_SOURCES: Sources = {
  arcana: 'D:\\model\\6901777523023878226.vrm',
  arcanaMobile: path.join(tmpdir(), 'airi-remote-assets', 'Arcana.mobile.vrm'),
  c583: 'D:\\AIWorkStation\\projects\\_nikke-models\\c583.zip',
  motions: 'D:\\AIWorkStation\\projects\\_mai-motions\\rexclaw',
  card: 'D:\\AIWorkStation\\projects\\airi\\custom\\cards\\thu-ky\\card.json',
}

export interface Upload { readonly file: string, readonly key: string, readonly contentType: string }

function upload(file: string, key: string): Upload {
  return { file, key: `${KEY_PREFIX}/${key}`, contentType: contentTypeFor(key) }
}

async function motionFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter(entry => entry.isFile() && entry.name.endsWith(MOTION_EXTENSION)).map(entry => entry.name).sort()
}

/** Every file to upload with its R2 key; motion file names keep their exact case. */
export async function planUploads(sources: Sources): Promise<Upload[]> {
  const motions = (await motionFiles(sources.motions)).map(name => upload(path.join(sources.motions, name), `motions/${name}`))
  const dancesDir = path.join(sources.motions, DANCES_DIR)
  const dances = (await motionFiles(dancesDir)).map(name => upload(path.join(dancesDir, name), `motions/${DANCES_DIR}/${name}`))
  return [
    upload(sources.arcana, 'models/arcana/Arcana.vrm'),
    upload(sources.arcanaMobile, 'models/arcana/Arcana.mobile.vrm'),
    upload(sources.c583, 'models/c583/c583.zip'),
    ...motions,
    ...dances,
    upload(sources.card, 'cards/thu-ky/card.json'),
  ]
}

/** Runs a command and returns its exit status; injectable so tests never call wrangler. */
export type Runner = (args: readonly string[]) => number

const quoteForShell = (arg: string): string => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg)

export const pnpmWrangler: Runner = (args) => {
  // pnpm is a .cmd shim on Windows, which only runs through a shell.
  const shell = process.platform === 'win32'
  const fullArgs = ['exec', 'wrangler', ...args].map(arg => (shell ? quoteForShell(arg) : arg))
  return spawnSync('pnpm', fullArgs, { stdio: 'inherit', shell }).status ?? 1
}

export function putArgs(bucket: string, item: Upload): string[] {
  return ['r2', 'object', 'put', `${bucket}/${item.key}`, '--file', item.file, '--remote', '--content-type', item.contentType]
}

export async function uploadAll(bucket: string, plan: readonly Upload[], run: Runner): Promise<void> {
  for (const item of plan) {
    if (run(putArgs(bucket, item)) !== 0)
      throw new Error(`upload failed: ${item.key}`)
  }
}

/** Downloads every key back from R2 and compares its size with the local file. Returns mismatches. */
export async function verifyAll(bucket: string, plan: readonly Upload[], run: Runner, scratchDir: string): Promise<string[]> {
  await mkdir(scratchDir, { recursive: true })
  const failures: string[] = []
  for (const [index, item] of plan.entries()) {
    const downloaded = path.join(scratchDir, `${index}${path.extname(item.key)}`)
    const status = run(['r2', 'object', 'get', `${bucket}/${item.key}`, '--file', downloaded, '--remote'])
    const expected = (await stat(item.file)).size
    const actual = status === 0 ? (await stat(downloaded).catch(() => undefined))?.size : undefined
    if (actual !== expected)
      failures.push(`${item.key}: expected ${expected} B, got ${actual ?? 'nothing'}`)
    await rm(downloaded, { force: true })
  }
  return failures
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false)
}

/** Writes the texture-reduced Arcana next to nothing in the repo (a temp path by default). */
export async function ensureMobileVrm(source: string, target: string, maxTextureSize = DEFAULT_MAX_TEXTURE_SIZE): Promise<void> {
  if (await exists(target))
    return
  await mkdir(path.dirname(target), { recursive: true })
  const { glb } = await shrinkGlb(new Uint8Array(await readFile(source)), maxTextureSize)
  await writeFile(target, glb)
}

export function resolveSources(values: Partial<Record<keyof Sources, string>>, env: NodeJS.ProcessEnv): Sources {
  const pick = (name: keyof Sources, envName: string): string => values[name] ?? env[envName] ?? DEFAULT_SOURCES[name]
  return {
    arcana: pick('arcana', 'REMOTE_ASSETS_ARCANA'),
    arcanaMobile: pick('arcanaMobile', 'REMOTE_ASSETS_ARCANA_MOBILE'),
    c583: pick('c583', 'REMOTE_ASSETS_C583'),
    motions: pick('motions', 'REMOTE_ASSETS_MOTIONS'),
    card: pick('card', 'REMOTE_ASSETS_CARD'),
  }
}

/** CLI entry: prints the plan, then uploads (default), only lists (`--dry-run`) or checks R2 (`--verify`). Returns the exit code. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, run: Runner, log: (line: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'dry-run': { type: 'boolean', default: false },
      'verify': { type: 'boolean', default: false },
      'bucket': { type: 'string' },
      'arcana': { type: 'string' },
      'arcana-mobile': { type: 'string' },
      'c583': { type: 'string' },
      'motions': { type: 'string' },
      'card': { type: 'string' },
    },
  })
  const sources = resolveSources({ ...values, arcanaMobile: values['arcana-mobile'] }, env)
  const bucket = values.bucket ?? env.REMOTE_ASSETS_BUCKET ?? DEFAULT_BUCKET
  await ensureMobileVrm(sources.arcana, sources.arcanaMobile)
  const plan = await planUploads(sources)
  for (const item of plan)
    log(`${(await stat(item.file)).size}\t${item.contentType}\t${item.key}`)
  log(`${plan.length} file(s) -> r2://${bucket}`)
  if (values['dry-run'])
    return 0
  if (!values.verify) {
    await uploadAll(bucket, plan, run)
    return 0
  }
  const failures = await verifyAll(bucket, plan, run, path.join(tmpdir(), 'airi-remote-assets', 'verify'))
  log(failures.length === 0 ? `verified ${plan.length} key(s)` : failures.join('\n'))
  return failures.length === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1]))
  process.exitCode = await main(process.argv.slice(2), process.env, pnpmWrangler, line => process.stdout.write(`${line}\n`))
