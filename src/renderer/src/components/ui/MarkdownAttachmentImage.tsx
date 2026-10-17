import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { getDesktopHost } from '@/lib/desktop-api'
import { attachmentImageIdentity, isLegacyAttachmentUrl, requestAttachmentImagePreview } from '@/lib/attachment-image-preview'

const unavailable = 'Image preview unavailable. Use Open or Download in attachments.'

/** Stable component identity preserves an owned preview while text streams. */
export function MarkdownAttachmentImage({ src, alt, ...props }: ComponentPropsWithoutRef<'img'>) {
  const host = getDesktopHost()
  const inert = host.kind !== 'electron' && isLegacyAttachmentUrl(src)
  const native = host.kind === 'tauri' && inert
  const identity = typeof src === 'string' ? attachmentImageIdentity(src) : undefined
  const taskId = identity?.taskId, attachmentId = identity?.attachmentId
  const element = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  const [preview, setPreview] = useState<{ source?: typeof src; generation?: number; url?: string; failed?: boolean; release?: () => void }>({})

  useEffect(() => {
    if (!native || !element.current || typeof IntersectionObserver === 'undefined') return
    let active = true
    const observer = new IntersectionObserver(entries => {
      if (active) setVisible(entries.at(-1)?.isIntersecting === true)
    }, { rootMargin: '200px' })
    observer.observe(element.current)
    return () => { active = false; observer.disconnect() }
  }, [native, src])

  useEffect(() => {
    if (!native || !taskId || !attachmentId || !visible) { setPreview({}); return }
    let retired = false, observed: string | undefined
    let release = () => {}
    const refresh = () => {
      if (retired) return
      const key = `${host.connectionGeneration}:${host.connection.status}`
      if (observed === key) return
      observed = key
      release(); release = () => {}; setPreview({})
      if (host.connection.status !== 'ready') return
      const generation = host.connectionGeneration
      const lease = { release: () => {} }
      lease.release = requestAttachmentImagePreview(host, { taskId, attachmentId }, url => { if (!retired) setPreview({ source: src, generation, url, release: () => lease.release() }) }, () => { if (!retired) setPreview({ source: src, generation, failed: true }) })
      release = () => lease.release()
    }
    const off = host.subscribeConnection(refresh)
    const retire = () => {
      if (retired) return
      retired = true; release(); off(); window.removeEventListener('pagehide', pagehide)
    }
    const pagehide = () => { retire(); setPreview({ source: src, generation: host.connectionGeneration, failed: true }) }
    window.addEventListener('pagehide', pagehide, { once: true })
    refresh()
    return retire
  }, [host, native, src, taskId, attachmentId, visible])

  if (!inert) return <img alt={alt || ''} src={src} {...props} />
  const current = preview.source === src && preview.generation === host.connectionGeneration
  return <span ref={element} className="inline-block max-w-full">
    {current && preview.url && host.connection.status === 'ready' ? <img key={preview.url} alt={alt || ''} src={preview.url} {...props} onError={() => {
      preview.release?.()
      setPreview(latest => latest.url === preview.url ? { source: src, generation: preview.generation, failed: true } : latest)
    }} />
      : <span role="status" className="text-xs text-muted-foreground">{!native || !identity || current && preview.failed ? unavailable : visible ? 'Loading image preview…' : 'Image preview loads when visible.'}</span>}
  </span>
}
