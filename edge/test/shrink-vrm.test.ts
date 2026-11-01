import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { buildGlb, type GltfJson, parseGlb, shrinkGlb } from '../scripts/shrink-vrm.ts'

const FLOATS = new Float32Array([1.5, -2.25, 3.125])

async function png(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width, height, channels: 4, background: { r: 200, g: 10, b: 50, alpha: 0.5 } } }).png().toBuffer())
}

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width, height, channels: 3, background: '#336699' } }).jpeg().toBuffer())
}

/** GLB with [large PNG, accessor floats, small JPEG, large JPEG] packed with 4-byte alignment. */
async function syntheticVrm(): Promise<{ glb: Uint8Array, json: GltfJson }> {
  const parts = [await png(2048, 512), new Uint8Array(FLOATS.buffer), await jpeg(300, 200), await jpeg(1500, 3000)]
  const views: { buffer: number, byteOffset: number, byteLength: number, target?: number }[] = []
  let length = 0
  for (const part of parts) {
    length = Math.ceil(length / 4) * 4
    views.push({ buffer: 0, byteOffset: length, byteLength: part.byteLength })
    length += part.byteLength
  }
  views[1].target = 34962
  const bin = new Uint8Array(length)
  parts.forEach((part, i) => bin.set(part, views[i].byteOffset))
  const json: GltfJson = {
    asset: { version: '2.0' },
    extensionsUsed: ['VRMC_vrm', 'VRMC_materials_mtoon'],
    extensions: { VRMC_vrm: { specVersion: '1.0', meta: { name: 'Synthetic' } } },
    materials: [{ extensions: { VRMC_materials_mtoon: { shadeColorFactor: [1, 0, 0] } } }],
    buffers: [{ byteLength: length }],
    bufferViews: views,
    accessors: [{ bufferView: 1, componentType: 5126, count: 1, type: 'VEC3' }],
    images: [
      { bufferView: 0, mimeType: 'image/png', name: 'body' },
      { bufferView: 2, mimeType: 'image/jpeg', name: 'small' },
      { bufferView: 3, mimeType: 'image/jpeg', name: 'tall' },
    ],
  }
  return { glb: buildGlb({ json, bin }), json }
}

function withoutLayout(json: GltfJson): unknown {
  return {
    ...json,
    buffers: json.buffers?.map(({ byteLength: _length, ...rest }) => rest),
    bufferViews: json.bufferViews?.map(({ byteOffset: _offset, byteLength: _length, ...rest }) => rest),
  }
}

function viewBytes(json: GltfJson, bin: Uint8Array, index: number): Uint8Array {
  const view = json.bufferViews![index]
  return bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
}

describe('shrinkGlb', () => {
  it('downscales oversized textures and keeps everything else intact', async () => {
    const original = await syntheticVrm()

    const { glb, images } = await shrinkGlb(original.glb, 1024)
    const { json, bin } = parseGlb(glb)

    expect(glb.byteLength).toBeLessThan(original.glb.byteLength)
    expect(withoutLayout(json)).toEqual(withoutLayout(original.json))
    expect(images.map(image => [image.index, image.to.width, image.to.height])).toEqual([[0, 1024, 256], [2, 512, 1024]])
    expect(await sharp(viewBytes(json, bin, 0)).metadata()).toMatchObject({ format: 'png', width: 1024, height: 256, hasAlpha: true })
    expect(await sharp(viewBytes(json, bin, 2)).metadata()).toMatchObject({ format: 'jpeg', width: 300, height: 200 })
    expect(await sharp(viewBytes(json, bin, 3)).metadata()).toMatchObject({ format: 'jpeg', width: 512, height: 1024 })
    const floats = viewBytes(json, bin, 1)
    expect(new Float32Array(floats.slice().buffer)).toEqual(FLOATS)
  })

  it('writes a valid GLB layout with aligned, in-bounds bufferViews', async () => {
    const { glb } = await shrinkGlb((await syntheticVrm()).glb, 1024)
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
    const { json, bin } = parseGlb(glb)

    expect(view.getUint32(8, true)).toBe(glb.byteLength)
    expect(view.getUint32(12, true) % 4).toBe(0)
    expect(json.buffers![0].byteLength).toBe(json.bufferViews!.reduce((end, v) => Math.max(end, (v.byteOffset ?? 0) + v.byteLength), 0))
    expect(bin.byteLength % 4).toBe(0)
    for (const bufferView of json.bufferViews!) {
      expect((bufferView.byteOffset ?? 0) % 4).toBe(0)
      expect((bufferView.byteOffset ?? 0) + bufferView.byteLength).toBeLessThanOrEqual(bin.byteLength)
    }
  })

  it('returns the input unchanged when every texture already fits', async () => {
    const { glb: input } = await syntheticVrm()

    const { glb, images } = await shrinkGlb(input, 4096)

    expect(glb).toBe(input)
    expect(images).toEqual([])
  })

  it('leaves non PNG/JPEG images and URI images alone', async () => {
    const json: GltfJson = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 4 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
      images: [{ bufferView: 0, mimeType: 'image/ktx2' }, { uri: 'texture.png' }],
    }
    const input = buildGlb({ json, bin: new Uint8Array([1, 2, 3, 4]) })

    const { glb, images } = await shrinkGlb(input, 1)

    expect(glb).toBe(input)
    expect(images).toEqual([])
  })

  it.each([
    ['external buffers', { buffers: [{ byteLength: 4, uri: 'data.bin' }] }],
    ['several buffers', { buffers: [{ byteLength: 4 }, { byteLength: 4 }] }],
    ['overlapping bufferViews', { buffers: [{ byteLength: 8 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 6 }, { buffer: 0, byteOffset: 4, byteLength: 4 }] }],
  ])('rejects %s', async (_label, overrides) => {
    const input = buildGlb({ json: { asset: { version: '2.0' }, ...overrides }, bin: new Uint8Array(8) })

    await expect(shrinkGlb(input)).rejects.toThrow(/supported/)
  })
})

describe('parseGlb', () => {
  it('round-trips JSON and binary chunks through buildGlb', () => {
    const json = { asset: { version: '2.0' }, extras: { name: 'Thư ký' } }
    const bin = new Uint8Array([9, 8, 7])

    const parsed = parseGlb(buildGlb({ json, bin }))

    expect(parsed.json).toEqual(json)
    expect([...parsed.bin.subarray(0, 3)]).toEqual([9, 8, 7])
  })

  it('omits the BIN chunk when there is no binary data', () => {
    const glb = buildGlb({ json: { asset: { version: '2.0' } }, bin: new Uint8Array(0) })

    expect(parseGlb(glb).bin.byteLength).toBe(0)
  })

  function header(magic: number, version: number, length: number, size = length): Uint8Array {
    const bytes = new Uint8Array(size)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, magic, true)
    view.setUint32(4, version, true)
    view.setUint32(8, length, true)
    return bytes
  }

  it.each([
    ['a file that is too short', new Uint8Array(4), /not a GLB/],
    ['a wrong magic number', header(0x12345678, 2, 12), /not a GLB/],
    ['GLB version 1', header(0x46546C67, 1, 12), /version 2/],
    ['a length mismatch', header(0x46546C67, 2, 99, 12), /does not match/],
    ['no JSON chunk', header(0x46546C67, 2, 12), /no JSON chunk/],
  ])('rejects %s', (_label, bytes, message) => {
    expect(() => parseGlb(bytes)).toThrow(message)
  })

  it('rejects a chunk that runs past the end of the file', () => {
    const bytes = header(0x46546C67, 2, 20)
    new DataView(bytes.buffer).setUint32(12, 100, true)

    expect(() => parseGlb(bytes)).toThrow(/past the end/)
  })
})
