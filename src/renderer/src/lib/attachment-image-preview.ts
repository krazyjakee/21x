import { captureDesktopRead, getDesktopHost, type DesktopHost } from './desktop-api'
import { isDatabaseId } from '@shared/database-desktop-codecs'
import { taskAttachmentId } from '@shared/task-attachment-codecs'
import { isAttachmentImage } from '@shared/attachment-image'
import { attachmentRaster } from '@shared/attachment-raster'

/** Across the physical document, including separate Markdown components.
 * Pixel accounting includes the canvas plus every admitted animation frame.
 * Browser decoder/cache allocations are implementation-dependent; these bounds
 * cover the URLs and images that this renderer admits and keeps resident. */
const LIMITS = { reads: 4, queued: 64, resident: 16, encodedBytes: 4 * 1024 * 1024, pixels: 16 * 1024 * 1024 }
export const isLegacyAttachmentUrl = (url: unknown): url is string => typeof url === 'string' && /^app-attachment:/i.test(url)
export function attachmentImageIdentity(url: string): { taskId: string; attachmentId: string } | undefined {
  // Literal identities only: no URL parser normalization, decoding or aliases.
  const match = /^app-attachment:\/\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})$/.exec(url)
  return match && isDatabaseId(match[1]) && taskAttachmentId(match[2]) ? { taskId: match[1], attachmentId: match[2] } : undefined
}
interface PreviewJob {
  active: boolean
  running: boolean
  current: () => boolean
  read: () => Promise<void>
  unavailable: () => void
  release?: () => void
}
const queue: PreviewJob[] = []
const jobs = new Set<PreviewJob>()
let running = 0, resident = 0, encodedBytes = 0, pixels = 0

function cancel(job: PreviewJob): void {
  job.active = false
  const index = queue.indexOf(job)
  if (index >= 0) queue.splice(index, 1)
  job.release?.()
  if (!job.running) jobs.delete(job)
}
function pump(): void {
  while (running < LIMITS.reads && queue.length) {
    const job = queue.shift()!
    if (!job.active) continue
    job.running = true; running++
    // Keep an admitted read's slot until its public promise settles, including
    // after unmount. Source independently owns and joins the underlying FD read.
    void Promise.resolve().then(() => { if (job.current()) return job.read(); return undefined })
      .catch(() => { job.release?.(); if (job.current()) job.unavailable() })
      .finally(() => { job.running = false; running--; if (!job.release) jobs.delete(job); pump() })
  }
}
export function retireAttachmentImagePreviews(): void {
  for (const job of jobs) cancel(job)
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', retireAttachmentImagePreviews)
if (import.meta.hot) import.meta.hot.dispose(() => {
  retireAttachmentImagePreviews()
  window.removeEventListener('pagehide', retireAttachmentImagePreviews)
})

/** A read-only preview lease. No path/scheme authority or general file read. */
export function requestAttachmentImagePreview(host: DesktopHost, identity: { taskId: string; attachmentId: string }, ready: (url: string) => void, unavailable: () => void): () => void {
  if (running >= LIMITS.reads && queue.length >= LIMITS.queued) { unavailable(); return () => {} }
  const scope = captureDesktopRead()
  const job: PreviewJob = {
    active: true, running: false,
    current: () => job.active && getDesktopHost() === host && scope.isCurrent(),
    unavailable,
    read: async () => {
      const read = host.api.attachments.readImage
      if (!host.supports('attachments.readImage') || !read) throw new Error('Preview unavailable')
      const image = await read(identity.taskId, identity.attachmentId)
      if (!job.current()) return
      if (!isAttachmentImage(image)) throw new Error('Preview unavailable')
      const bytes = Uint8Array.from(atob(image.data), character => character.charCodeAt(0))
      const raster = attachmentRaster(bytes, image.mimeType)
      if (!raster) throw new Error('Preview unavailable')
      const cost = raster.width * raster.height * (raster.frames + 1), size = bytes.length
      if (resident >= LIMITS.resident || encodedBytes + size > LIMITS.encodedBytes || pixels + cost > LIMITS.pixels) throw new Error('Preview unavailable')
      const url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }))
      resident++; encodedBytes += size; pixels += cost
      job.release = () => {
        if (!job.release) return
        job.release = undefined
        URL.revokeObjectURL(url)
        resident--; encodedBytes -= size; pixels -= cost
        if (!job.running) jobs.delete(job)
      }
      ready(url)
    }
  }
  jobs.add(job); queue.push(job); pump()
  return () => cancel(job)
}
