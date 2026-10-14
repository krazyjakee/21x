import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { VoiceModelManifestEntry } from '../../shared/voice'
import { VoiceModelDownloadPolicy, VOICE_MODEL_REDIRECT_LIMIT, VOICE_MODEL_DOWNLOAD_METADATA_BYTES } from './voice-model-download-policy'

const repo = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
const revision = '2bda32ec70b097a55adaa07d9a7173915b43cc78'
const initial = `https://huggingface.co/${repo}/resolve/${revision}/encoder.int8.onnx`
const cache = `https://huggingface.co/api/resolve-cache/models/${repo}/${revision}/encoder.int8.onnx`
const bytes = Buffer.from('fixed synthetic recognition file')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const xetHash = 'b'.repeat(64), objectId = 'a'.repeat(24), path = `/xet-bridge-us/${objectId}/${xetHash}`
const cdn = `https://us.aws.cdn.hf.co${path}?Expires=1900000000&X-Xet-Cas-Uid=public`
function entry(): VoiceModelManifestEntry {
  return { id: 'fixture', label: 'Fixture', description: 'No live model', languages: ['en'], license: 'Apache-2.0', licenseUrl: 'https://example.invalid/license', minMemoryBytes: 1,
    files: [{ name: 'encoder.onnx', url: initial, sha256, sizeBytes: bytes.length }], roles: { encoder: 'encoder.onnx', decoder: 'decoder.onnx', joiner: 'joiner.onnx', tokens: 'tokens.txt' } }
}
function publisher(location = cdn, extra: Record<string, string> = {}, body: BodyInit | null = null): Response {
  return new Response(body, { status: 302, headers: { location, 'x-repo-commit': revision, 'x-linked-etag': `"${sha256}"`, 'x-linked-size': String(bytes.length), 'x-xet-hash': xetHash, ...extra } })
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function request(policy: VoiceModelDownloadPolicy, fetchImpl: typeof fetch, assertCurrent = () => {}, signal = new AbortController().signal) {
  return policy.request(initial, { fetchImpl, assertCurrent, signal })
}

describe('finite recognition model resource policy', () => {
  it('freezes exact verified initial resources and rejects later catalogue mutations/caller URLs', async () => {
    const source = entry(), policy = new VoiceModelDownloadPolicy([source]), fetchImpl = vi.fn(async () => new Response(bytes))
    source.files[0].url = `${initial}?download=true`; source.files[0].sha256 = 'c'.repeat(64)
    const response = await request(policy, fetchImpl as typeof fetch); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    await expect(policy.request(source.files[0].url, { fetchImpl: fetchImpl as typeof fetch, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('POLICY_REFUSED')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(() => new VoiceModelDownloadPolicy([{ ...entry(), files: [{ ...entry().files[0], url: 'https://example.invalid/model.onnx' }] }])).toThrow('POLICY_REFUSED')
    expect(() => new VoiceModelDownloadPolicy([{ ...entry(), files: [{ ...entry().files[0], sha256: '' }] }])).toThrow('POLICY_REFUSED')
  })
  it('follows only the same pinned publisher cache resource and then a metadata-bound CDN object', async () => {
    const calls: string[] = [], guards = vi.fn(), beforeRequest = vi.fn(), policy = new VoiceModelDownloadPolicy([entry()])
    const firstCleanup = vi.fn(), secondCleanup = vi.fn()
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url))
      if (calls.length === 1) return new Response(new ReadableStream({ cancel: firstCleanup }), { status: 307, headers: { location: new URL(cache).pathname } })
      if (calls.length === 2) return publisher(cdn, {}, new ReadableStream({ cancel: secondCleanup }))
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
    })
    const response = await policy.request(initial, { fetchImpl: fetchImpl as typeof fetch, signal: new AbortController().signal, assertCurrent: guards, beforeRequest })
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(calls).toEqual([initial, cache, cdn]); expect(firstCleanup).toHaveBeenCalledOnce(); expect(secondCleanup).toHaveBeenCalledOnce()
    expect(beforeRequest).toHaveBeenCalledTimes(3); expect(guards.mock.calls.length).toBeGreaterThan(3)
    for (const [, options] of fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>) expect(options).toEqual(expect.objectContaining({ redirect: 'manual', credentials: 'omit', headers: { 'Accept-Encoding': 'identity' } }))
    expect(xetHash).not.toBe(sha256)
  })
  it('accepts only the exact original pinned resolve reference used by the public cache redirect', async () => {
    const pointer = encodeURIComponent(new URL(initial).pathname)
    const destination = `${cache}?${pointer}=&etag=%22${'a'.repeat(40)}%22`
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: destination } })).mockResolvedValueOnce(new Response(bytes))
    const response = await request(new VoiceModelDownloadPolicy([entry()]), fetchImpl as typeof fetch)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes); expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it.each([
    'https://example.invalid/model.onnx', `http://us.aws.cdn.hf.co${path}`, `https://user:secret@us.aws.cdn.hf.co${path}`,
    `https://us.aws.cdn.hf.co:443${path}`, `https://us.aws.cdn.hf.co:8443${path}`, `https://us.aws.cdn.hf.co.${path}`,
    `https://us.aws.cdn.hf.co.evil.invalid${path}`, `https://127.0.0.1${path}`, `https://[::1]${path}`, `https://2130706433${path}`,
    `https://localhost${path}`, `https://169.254.169.254${path}`, `https://10.0.0.1${path}`, `file:///model.onnx`, `//us.aws.cdn.hf.co${path}`,
    `https://us.aws.cdn.hf.co/other/${xetHash}`, `https://us.aws.cdn.hf.co${path}/extra`, `https://us.aws.cdn.hf.co${path}#fragment`,
    `https://us.aws.cdn.hf.co${path}?token=private`, `https://us.aws.cdn.hf.co${path}?X-Xet-Cas-Uid=private`,
    `https://us.aws.cdn.hf.co${path}?Expires=1&Expires=2`, `https://us.aws.cdn.hf.co/xet-bridge-us/${objectId}/${'c'.repeat(64)}`,
    `https://huggingface.co/foreign/repo/resolve/${revision}/encoder.int8.onnx`, cache.replace(revision, 'c'.repeat(40)),
    cache.replace('encoder.int8.onnx', 'decoder.int8.onnx'), `${cache}?Authorization=secret`,
    `${cache}?${encodeURIComponent(new URL(initial).pathname)}=foreign`,
    `${cache}?${encodeURIComponent(new URL(initial).pathname.replace('encoder.int8.onnx', 'decoder.int8.onnx'))}=`,
    `/api/resolve-cache/models/${repo}/${revision}/ignored/../encoder.int8.onnx`,
    `/api/resolve-cache/models/${repo}/${revision}/%65ncoder.int8.onnx`,
  ])('refuses destination %s before a second request', async location => {
    const fetchImpl = vi.fn(async () => publisher(location)), policy = new VoiceModelDownloadPolicy([entry()])
    await expect(request(policy, fetchImpl as typeof fetch)).rejects.toThrow('POLICY_REFUSED')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it.each(['x-repo-commit','x-linked-etag','x-linked-size','x-xet-hash'])('requires exact original publisher metadata: %s', async name => {
    const fetchImpl = vi.fn(async () => { const response = publisher(); response.headers.delete(name); return response })
    await expect(request(new VoiceModelDownloadPolicy([entry()]), fetchImpl as typeof fetch)).rejects.toThrow('POLICY_REFUSED')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it('rejects CDN resource rebinding and a return to the publisher after a bound CDN hop', async () => {
    for (const destination of [`https://cas-bridge.xethub.hf.co/xet-bridge-us/${'d'.repeat(24)}/${xetHash}`, initial]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(publisher()).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: destination } }))
      await expect(request(new VoiceModelDownloadPolicy([entry()]), fetchImpl as typeof fetch)).rejects.toThrow('POLICY_REFUSED')
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    }
  })
  it('allows reviewed CDN host transitions only while the exact object path remains bound', async () => {
    const target = `https://cas-bridge.xethub.hf.co${path}?Expires=1900000001`
    const fetchImpl = vi.fn().mockResolvedValueOnce(publisher()).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: target } })).mockResolvedValueOnce(new Response(bytes))
    const response = await request(new VoiceModelDownloadPolicy([entry()]), fetchImpl as typeof fetch)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes); expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
  it('bounds cycles, hop count and UTF8 response metadata before further requests', async () => {
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: initial } }))
    await expect(request(new VoiceModelDownloadPolicy([entry()]), loop as typeof fetch)).rejects.toThrow('POLICY_REFUSED'); expect(loop).toHaveBeenCalledOnce()
    let index = 0
    const hops = vi.fn(async () => new Response(null, { status: 302, headers: { location: `${cache}?etag=${String.fromCharCode(97 + index++).repeat(40)}` } }))
    await expect(request(new VoiceModelDownloadPolicy([entry()]), hops as typeof fetch)).rejects.toThrow('POLICY_REFUSED')
    expect(hops).toHaveBeenCalledTimes(VOICE_MODEL_REDIRECT_LIMIT + 1)
    const huge = vi.fn(async () => publisher(cdn, { 'x-extra': 'x'.repeat(VOICE_MODEL_DOWNLOAD_METADATA_BYTES) }))
    await expect(request(new VoiceModelDownloadPolicy([entry()]), huge as typeof fetch)).rejects.toThrow('POLICY_REFUSED'); expect(huge).toHaveBeenCalledOnce()
  })
  it('joins intermediate cancellation and rechecks a revoked grant before the next request', async () => {
    let allowed = true, settled = false
    const cleaning = deferred<void>(), receipt = deferred<void>()
    const fetchImpl = vi.fn(async () => publisher(cdn, {}, new ReadableStream({ cancel() { cleaning.resolve(); return receipt.promise } })))
    const work = request(new VoiceModelDownloadPolicy([entry()]), fetchImpl as typeof fetch, () => { if (!allowed) throw new Error('GRANT_REPLACED') }).catch(error => { settled = true; return error })
    await cleaning.promise; allowed = false; await Promise.resolve(); expect(settled).toBe(false)
    receipt.resolve(); expect((await work).message).toBe('GRANT_REPLACED'); expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it('owns a late ignored-abort response and its cleanup; pre-aborted work sends nothing', async () => {
    const controller = new AbortController(), fetched = deferred<Response>(), entered = deferred<void>(), cleaning = deferred<void>(), receipt = deferred<void>()
    const fetchImpl = vi.fn(async () => { entered.resolve(); return fetched.promise })
    const policy = new VoiceModelDownloadPolicy([entry()])
    let settled = false
    const work = request(policy, fetchImpl as typeof fetch, () => {}, controller.signal).catch(error => { settled = true; return error })
    await entered.promise; controller.abort()
    fetched.resolve(publisher(cdn, {}, new ReadableStream({ cancel() { cleaning.resolve(); return receipt.promise } })))
    await cleaning.promise; expect(settled).toBe(false); receipt.resolve()
    expect((await work).message).toBe('VOICE_MODEL_ABORTED'); expect(fetchImpl).toHaveBeenCalledOnce()
    await expect(request(policy, fetchImpl as typeof fetch, () => {}, controller.signal)).rejects.toThrow('ABORTED'); expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it('rejects automatic follow, wrong final lengths, ambiguous resources and malformed metadata with fixed errors', async () => {
    for (const response of [new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } }), new Response(bytes, { status: 206 })]) {
      const fetchImpl = vi.fn(async () => response)
      await expect(request(new VoiceModelDownloadPolicy([entry()]), fetchImpl as typeof fetch)).rejects.toThrow(/VOICE_MODEL_DOWNLOAD_(POLICY_REFUSED|FAILED)/)
      expect(fetchImpl).toHaveBeenCalledOnce()
    }
    const followed = new Response(bytes); Object.defineProperty(followed, 'redirected', { value: true })
    await expect(request(new VoiceModelDownloadPolicy([entry()]), vi.fn(async () => followed) as typeof fetch)).rejects.toThrow('POLICY_REFUSED')
    const malformed = publisher(cdn, { 'x-linked-etag': `"${sha256}` })
    await expect(request(new VoiceModelDownloadPolicy([entry()]), vi.fn(async () => malformed) as typeof fetch)).rejects.toThrow('POLICY_REFUSED')
    const second = entry(); second.files[0].sha256 = 'c'.repeat(64)
    expect(() => new VoiceModelDownloadPolicy([entry(), second])).toThrow('POLICY_REFUSED')
    const failed = vi.fn(async () => { throw new Error(`${cdn}&Signature=must-never-escape`) })
    await expect(request(new VoiceModelDownloadPolicy([entry()]), failed as typeof fetch)).rejects.toThrow('VOICE_MODEL_DOWNLOAD_REQUEST_FAILED')
  })
})
