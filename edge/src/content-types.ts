const DEFAULT_CONTENT_TYPE = 'application/octet-stream'
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.vrm': 'model/gltf-binary',
  '.vrma': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

/** Content-Type for an R2 key by extension; shared by the Worker and the upload script. */
export function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf('.')
  return (dot === -1 ? undefined : CONTENT_TYPES[key.slice(dot).toLowerCase()]) ?? DEFAULT_CONTENT_TYPE
}
