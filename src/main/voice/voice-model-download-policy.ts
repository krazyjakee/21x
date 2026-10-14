import type { VoiceModelManifestEntry } from '../../shared/voice'

/** Reviewed 2026-10-14: official HF model-download docs, endpoint metadata,
 * migration-to-Xet blog and huggingface_hub/file_download.py. The complete
 * source URLs and the deliberately narrower supported subset are documented
 * in docs/tauri-migration/voice-recognition-owner.md. No wildcard grants. */
export const VOICE_MODEL_REDIRECT_LIMIT = 4
export const VOICE_MODEL_DOWNLOAD_METADATA_BYTES = 16384
export const VOICE_MODEL_DOWNLOAD_DEADLINE_MS = 20 * 60 * 1000
export const VOICE_MODEL_DOWNLOAD_CDN_HOSTS = Object.freeze([
  'cas-bridge.xethub.hf.co', 'us.aws.cdn.hf.co', 'us.gcp.cdn.hf.co',
] as const)
const repositories: Readonly<Record<string, string>> = Object.freeze({
  'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8': '2bda32ec70b097a55adaa07d9a7173915b43cc78',
  'csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26': '672fbf1b30579d6585301139bb363f42a0ad4a24',
  'csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8': 'df8ed95e44a70924450381e610770f9d656d1e15',
  'csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25': '52056fdc070914a48dcd68b31b44d6a6f5b85902',
})
const redirects = new Set([301, 302, 303, 307, 308])
const cdnHosts: ReadonlySet<string> = new Set(VOICE_MODEL_DOWNLOAD_CDN_HOSTS)
interface Resource { url: string; repo: string; revision: string; filename: string; sha256: string; sizeBytes: number }
interface Binding { path: string; xetHash: string }
export interface VoiceModelDownloadRequest {
  fetchImpl: typeof fetch
  signal: AbortSignal
  assertCurrent(): void
  beforeRequest?(): void
}
function refuse(): never { throw new Error('VOICE_MODEL_DOWNLOAD_POLICY_REFUSED') }
function bounded(value: string, max = VOICE_MODEL_DOWNLOAD_METADATA_BYTES): string {
  if (Buffer.byteLength(value, 'utf8') > max || /[^\x21-\x7e]/.test(value)) refuse()
  return value
}
function parse(raw: string): URL {
  bounded(raw)
  // Reject spellings which URL normalization would otherwise erase, including
  // default ports, trailing dots, userinfo, dot segments and escaped paths.
  const authority = /^https:\/\/([a-z0-9.-]+)(?=\/|$)/.exec(raw)?.[1]
  if (!authority) refuse()
  let url: URL
  try { url = new URL(raw) } catch { return refuse() }
  const path = raw.slice(raw.indexOf('/', 'https://'.length)).split('?')[0]
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.hostname !== authority || authority.endsWith('.') || /[%\\]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) refuse()
  return url
}
function header(response: Response, name: string, limit = 1024): string | null {
  const value = response.headers.get(name)
  if (value === null) return null
  if (Buffer.byteLength(value, 'utf8') > limit || /[\u0000-\u001f\u007f]/.test(value)) refuse()
  return value
}
function boundedHeaders(response: Response): void {
  let count = 0, bytes = 0
  for (const [key, value] of response.headers) {
    bytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8')
    if (++count > 64 || bytes > VOICE_MODEL_DOWNLOAD_METADATA_BYTES) refuse()
  }
}
function publisherQuery(url: URL, resource: Resource): void {
  const seen = new Set<string>()
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) refuse()
    seen.add(key)
    // HF's cache redirect carries the original pinned resolve path as an
    // encoded empty query key. It is a reference to this exact resource.
    if (url.pathname === `/api/resolve-cache/models/${resource.repo}/${resource.revision}/${resource.filename}` && key === `/${resource.repo}/resolve/${resource.revision}/${resource.filename}` && value === '') continue
    if (key === 'download' && (value === 'true' || value === 'false')) continue
    if (key === 'etag' && /^"?[a-f0-9]{40}(?:[a-f0-9]{24})?"?$/.test(value)) continue
    refuse()
  }
}
function cdnQuery(url: URL): void {
  const seen = new Set<string>()
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || Buffer.byteLength(value, 'utf8') > 8192 || /[\u0000-\u001f\u007f]/.test(value)) refuse()
    seen.add(key)
    if (['Expires','X-Amz-Expires'].includes(key) && /^[0-9]{1,16}$/.test(value)) continue
    if (key === 'Key-Pair-Id' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) continue
    if (['Policy','Signature'].includes(key) && /^[A-Za-z0-9+\/=_~.-]{1,8192}$/.test(value)) continue
    if (key === 'X-Amz-Algorithm' && value === 'AWS4-HMAC-SHA256') continue
    if (key === 'X-Amz-Content-Sha256' && value === 'UNSIGNED-PAYLOAD') continue
    if (key === 'X-Amz-Credential' && /^cas\/[0-9]{8}\/[a-z0-9-]{1,32}\/s3\/aws4_request$/.test(value)) continue
    if (key === 'X-Amz-Date' && /^[0-9]{8}T[0-9]{6}Z$/.test(value)) continue
    if (key === 'X-Amz-Signature' && /^[a-f0-9]{64}$/.test(value)) continue
    if (key === 'X-Amz-SignedHeaders' && value === 'host') continue
    if (key === 'X-Xet-Cas-Uid' && value === 'public') continue
    if (key === 'x-id' && value === 'GetObject') continue
    if (['response-content-disposition','response-content-type'].includes(key) && value.length <= 2048) continue
    refuse()
  }
}
async function cancel(response: Response): Promise<void> {
  if (!response.body) return
  try {
    const reader = response.body.getReader()
    try { await reader.cancel() } finally { reader.releaseLock() }
  } catch { throw new Error('VOICE_MODEL_DOWNLOAD_RESPONSE_CLEANUP_FAILED') }
}

/** The caller passes its constructor-frozen catalogue, never renderer URLs or
 * environment endpoints. The manager retains this entire operation and owns
 * the returned final Response until its body is consumed/cancelled. */
export class VoiceModelDownloadPolicy {
  private readonly resources = new Map<string, Resource>()
  constructor(catalogue: readonly VoiceModelManifestEntry[]) {
    for (const entry of catalogue) for (const file of entry.files) {
      const url = parse(file.url)
      const match = /^\/([^/]+\/[^/]+)\/resolve\/([a-f0-9]{40})\/([A-Za-z0-9][A-Za-z0-9._-]{0,191})$/.exec(url.pathname)
      if (url.hostname !== 'huggingface.co' || url.search || !match || repositories[match[1]] !== match[2] || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || file.sizeBytes > 1024 ** 3) refuse()
      const resource: Resource = { url: file.url, repo: match[1], revision: match[2], filename: match[3], sha256: file.sha256, sizeBytes: file.sizeBytes }
      const prior = this.resources.get(file.url)
      if (prior && (prior.sha256 !== resource.sha256 || prior.sizeBytes !== resource.sizeBytes)) refuse()
      this.resources.set(file.url, Object.freeze(resource))
    }
  }
  async request(initial: string, options: VoiceModelDownloadRequest): Promise<Response> {
    const resource = this.resources.get(initial)
    if (!resource) refuse()
    let url = initial, binding: Binding | null = null
    const seen = new Set<string>()
    const current = (): void => { options.assertCurrent(); if (options.signal.aborted) throw new Error('VOICE_MODEL_ABORTED') }
    for (let hop = 0; ; hop++) {
      current()
      if (seen.has(url)) refuse()
      seen.add(url)
      options.beforeRequest?.(); current()
      let response: Response
      try { response = await options.fetchImpl(url, { signal: options.signal, redirect: 'manual', credentials: 'omit', headers: { 'Accept-Encoding': 'identity' } }) }
      catch { current(); throw new Error('VOICE_MODEL_DOWNLOAD_REQUEST_FAILED') }
      let returned = false
      try {
        current()
        boundedHeaders(response)
        if (response.redirected || response.url && response.url !== url) refuse()
        if (!redirects.has(response.status)) {
          if (response.status !== 200 || !response.body) throw new Error('VOICE_MODEL_DOWNLOAD_FAILED')
          const contentLength = header(response, 'content-length', 32)
          if (contentLength !== null && (!/^(0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) !== resource.sizeBytes)) refuse()
          current(); returned = true; return response
        }
        if (hop === VOICE_MODEL_REDIRECT_LIMIT) refuse()
        const location = header(response, 'location', VOICE_MODEL_DOWNLOAD_METADATA_BYTES)
        if (!location) refuse()
        let next: string
        if (location.startsWith('/') && !location.startsWith('//')) next = `${parse(url).origin}${location}`
        else next = location
        const destination = parse(next), source = parse(url)
        if (destination.hostname === 'huggingface.co') {
          if (binding || source.hostname !== 'huggingface.co') refuse()
          const cachePath = `/api/resolve-cache/models/${resource.repo}/${resource.revision}/${resource.filename}`
          const resolvePath = `/${resource.repo}/resolve/${resource.revision}/${resource.filename}`
          if (destination.pathname !== cachePath && destination.pathname !== resolvePath) refuse()
          publisherQuery(destination, resource)
        } else {
          if (!cdnHosts.has(destination.hostname)) refuse()
          const object = /^\/xet-bridge-us\/([a-f0-9]{24})\/([a-f0-9]{64})$/.exec(destination.pathname)
          if (!object) refuse()
          cdnQuery(destination)
          if (binding) {
            if (destination.pathname !== binding.path || object[2] !== binding.xetHash) refuse()
          } else {
            if (source.hostname !== 'huggingface.co') refuse()
            const rawEtag = header(response, 'x-linked-etag', 128)
            const etagMatch = rawEtag && /^(?:([a-f0-9]{64})|"([a-f0-9]{64})")$/.exec(rawEtag)
            const etag = etagMatch ? etagMatch[1] ?? etagMatch[2] : null
            const size = header(response, 'x-linked-size', 32)
            const xetHash = header(response, 'x-xet-hash', 64)
            if (header(response, 'x-repo-commit', 40) !== resource.revision || etag !== resource.sha256 || size !== String(resource.sizeBytes) || xetHash !== object[2]) refuse()
            // Xet's CAS hash is distinct from the manifest's file SHA256.
            binding = { path: destination.pathname, xetHash }
          }
        }
        // Join intermediate body cancellation before authorizing the next hop.
        await cancel(response); current()
        returned = true; url = next
      } finally { if (!returned) await cancel(response) }
    }
  }
}
