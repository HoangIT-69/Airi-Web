/**
 * Makes a lighter copy of a VRM (GLB) for phones by downscaling its embedded textures.
 * Only image bytes change: the JSON chunk is kept as-is (every VRM / VRMC_* / MToon extension
 * included) except bufferView byteOffset/byteLength and buffers[0].byteLength, which are rewritten
 * for the new binary layout. Images keep their mime type.
 * Usage: node scripts/shrink-vrm.ts <input.vrm> <output.vrm> [maxTextureSize=1024]
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

export const DEFAULT_MAX_TEXTURE_SIZE = 1024
const GLB_MAGIC = 0x46546C67 // 'glTF'
const GLB_VERSION = 2
const CHUNK_JSON = 0x4E4F534A // 'JSON'
const CHUNK_BIN = 0x004E4942 // 'BIN\0'
const HEADER_BYTES = 12
const CHUNK_HEADER_BYTES = 8
// bufferViews start on 4-byte boundaries so every accessor component type stays aligned.
const ALIGNMENT = 4
const JSON_PADDING = 0x20
const JPEG_QUALITY = 90
const PNG_COMPRESSION_LEVEL = 9
const RESIZABLE_MIME_TYPES = new Set(['image/png', 'image/jpeg'])

interface BufferView { buffer: number, byteOffset?: number, byteLength: number, [key: string]: unknown }
interface GltfImage { bufferView?: number, mimeType?: string, [key: string]: unknown }
export interface GltfJson {
  buffers?: { byteLength: number, uri?: string, [key: string]: unknown }[]
  bufferViews?: BufferView[]
  images?: GltfImage[]
  [key: string]: unknown
}

export interface Glb { readonly json: GltfJson, readonly bin: Uint8Array }

export interface ImageReport {
  readonly index: number
  readonly mimeType: string
  readonly from: { width: number, height: number, bytes: number }
  readonly to: { width: number, height: number, bytes: number }
}

const align = (value: number): number => Math.ceil(value / ALIGNMENT) * ALIGNMENT

export function parseGlb(data: Uint8Array): Glb {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data.byteLength < HEADER_BYTES || view.getUint32(0, true) !== GLB_MAGIC)
    throw new Error('not a GLB file')
  if (view.getUint32(4, true) !== GLB_VERSION)
    throw new Error('only GLB version 2 is supported')
  if (view.getUint32(8, true) !== data.byteLength)
    throw new Error('GLB header length does not match the file size')

  let json: GltfJson | undefined
  let bin: Uint8Array = new Uint8Array(0)
  for (let offset = HEADER_BYTES; offset < data.byteLength;) {
    const length = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    const start = offset + CHUNK_HEADER_BYTES
    if (start + length > data.byteLength)
      throw new Error('GLB chunk runs past the end of the file')
    const chunk = data.subarray(start, start + length)
    if (type === CHUNK_JSON)
      json = JSON.parse(new TextDecoder().decode(chunk)) as GltfJson
    else if (type === CHUNK_BIN)
      bin = chunk
    offset = start + length
  }
  if (!json)
    throw new Error('GLB has no JSON chunk')
  return { json, bin }
}

function chunk(type: number, payload: Uint8Array, padByte: number): Uint8Array {
  const padded = new Uint8Array(CHUNK_HEADER_BYTES + align(payload.byteLength)).fill(padByte, CHUNK_HEADER_BYTES)
  const view = new DataView(padded.buffer)
  view.setUint32(0, align(payload.byteLength), true)
  view.setUint32(4, type, true)
  padded.set(payload, CHUNK_HEADER_BYTES)
  return padded
}

export function buildGlb({ json, bin }: Glb): Uint8Array {
  const parts = [chunk(CHUNK_JSON, new TextEncoder().encode(JSON.stringify(json)), JSON_PADDING)]
  if (bin.byteLength > 0)
    parts.push(chunk(CHUNK_BIN, bin, 0))
  const total = HEADER_BYTES + parts.reduce((sum, part) => sum + part.byteLength, 0)
  const glb = new Uint8Array(total)
  const view = new DataView(glb.buffer)
  view.setUint32(0, GLB_MAGIC, true)
  view.setUint32(4, GLB_VERSION, true)
  view.setUint32(8, total, true)
  let offset = HEADER_BYTES
  for (const part of parts) {
    glb.set(part, offset)
    offset += part.byteLength
  }
  return glb
}

async function downscale(bytes: Uint8Array, mimeType: string, maxSize: number): Promise<{ bytes: Uint8Array, report: Omit<ImageReport, 'index' | 'mimeType'> } | undefined> {
  const { width = 0, height = 0 } = await sharp(bytes).metadata()
  if (Math.max(width, height) <= maxSize)
    return undefined
  const resized = sharp(bytes).resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true })
  const encoded = mimeType === 'image/png'
    ? resized.png({ compressionLevel: PNG_COMPRESSION_LEVEL })
    : resized.jpeg({ quality: JPEG_QUALITY })
  const { data, info } = await encoded.toBuffer({ resolveWithObject: true })
  return {
    bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    report: { from: { width, height, bytes: bytes.byteLength }, to: { width: info.width, height: info.height, bytes: data.byteLength } },
  }
}

/** Returns the bytes each image bufferView should hold after downscaling (only changed ones). */
async function shrinkImages(json: GltfJson, bin: Uint8Array, maxSize: number): Promise<{ replacements: Map<number, Uint8Array>, images: ImageReport[] }> {
  const views = json.bufferViews ?? []
  const replacements = new Map<number, Uint8Array>()
  const images: ImageReport[] = []
  for (const [index, image] of (json.images ?? []).entries()) {
    if (image.bufferView === undefined || !image.mimeType || !RESIZABLE_MIME_TYPES.has(image.mimeType))
      continue
    if (replacements.has(image.bufferView))
      continue
    const view = views[image.bufferView]
    const offset = view.byteOffset ?? 0
    const result = await downscale(bin.subarray(offset, offset + view.byteLength), image.mimeType, maxSize)
    if (!result)
      continue
    replacements.set(image.bufferView, result.bytes)
    images.push({ index, mimeType: image.mimeType, ...result.report })
  }
  return { replacements, images }
}

function assertSingleEmbeddedBuffer(json: GltfJson): void {
  const buffers = json.buffers ?? []
  if (buffers.length > 1 || buffers.some(buffer => buffer.uri !== undefined))
    throw new Error('only GLBs with a single embedded buffer are supported')
  const views = [...(json.bufferViews ?? [])].sort((a, b) => (a.byteOffset ?? 0) - (b.byteOffset ?? 0))
  for (let i = 1; i < views.length; i++) {
    if ((views[i].byteOffset ?? 0) < (views[i - 1].byteOffset ?? 0) + views[i - 1].byteLength)
      throw new Error('overlapping bufferViews are not supported')
  }
}

/** Downscales embedded PNG/JPEG textures whose longest side exceeds `maxSize`. */
export async function shrinkGlb(data: Uint8Array, maxSize = DEFAULT_MAX_TEXTURE_SIZE): Promise<{ glb: Uint8Array, images: ImageReport[] }> {
  const { json, bin } = parseGlb(data)
  assertSingleEmbeddedBuffer(json)
  const { replacements, images } = await shrinkImages(json, bin, maxSize)
  if (replacements.size === 0)
    return { glb: data, images }

  // Repack every bufferView in its original order; untouched views keep their bytes.
  const views = json.bufferViews ?? []
  const order = views.map((_view, index) => index).sort((a, b) => (views[a].byteOffset ?? 0) - (views[b].byteOffset ?? 0))
  const sources = views.map((view, index) => replacements.get(index) ?? bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength))
  let length = 0
  for (const index of order)
    length = align(length) + sources[index].byteLength
  const newBin = new Uint8Array(length)
  let offset = 0
  for (const index of order) {
    offset = align(offset)
    newBin.set(sources[index], offset)
    views[index].byteOffset = offset
    views[index].byteLength = sources[index].byteLength
    offset += sources[index].byteLength
  }
  json.buffers![0].byteLength = newBin.byteLength
  return { glb: buildGlb({ json, bin: newBin }), images }
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const [input, output, max] = process.argv.slice(2)
  if (!input || !output)
    throw new Error('usage: node scripts/shrink-vrm.ts <input.vrm> <output.vrm> [maxTextureSize]')
  const maxSize = max ? Number(max) : DEFAULT_MAX_TEXTURE_SIZE
  if (!Number.isInteger(maxSize) || maxSize <= 0)
    throw new Error(`invalid max texture size: ${max}`)
  const { glb, images } = await shrinkGlb(new Uint8Array(await readFile(input)), maxSize)
  await writeFile(output, glb)
  for (const image of images)
    process.stdout.write(`image ${image.index} ${image.mimeType}: ${image.from.width}x${image.from.height} (${image.from.bytes} B) -> ${image.to.width}x${image.to.height} (${image.to.bytes} B)\n`)
  process.stdout.write(`${input}: ${(await stat(input)).size} B -> ${output}: ${glb.byteLength} B\n`)
}
