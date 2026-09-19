import { useEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import type { ChatImageRef } from '@shared/chat-images'
import { cn } from '@/lib/utils'

interface ChatMessageImagesProps {
  images: ChatImageRef[]
  /** Resolves an image id to a displayable URL (null when it cannot be loaded). */
  load: (id: string) => Promise<string | null>
  /** Synchronous lookup so already-known images render on the first paint. */
  cached?: (id: string) => string | undefined
  className?: string
}

function StoredImage({ image, load, cached }: { image: ChatImageRef } & Pick<ChatMessageImagesProps, 'load' | 'cached'>) {
  const wrapper = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const [url, setUrl] = useState<string | null | undefined>(() => visible ? cached?.(image.id) : undefined)

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !wrapper.current) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '200px' })
    observer.observe(wrapper.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) {
      setUrl(undefined)
      return
    }
    const hit = cached?.(image.id)
    if (hit) {
      setUrl(hit)
      return
    }
    let live = true
    void load(image.id)
      .then((next) => { if (live) setUrl(next) })
      .catch(() => { if (live) setUrl(null) })
    return () => { live = false }
  }, [image.id, load, cached, visible])

  return (
    <span ref={wrapper} className="inline-block min-h-20 min-w-28" data-testid="chat-message-image">
      {visible && url === null ? (
        <span role="img" aria-label={`Unavailable image: ${image.name}`} className="inline-flex h-20 w-28 flex-col items-center justify-center gap-1 rounded-lg border border-border bg-muted text-[10px] text-muted-foreground">
          <ImageOff className="size-4" aria-hidden="true" />
          <span className="max-w-full truncate px-1">{image.name}</span>
        </span>
      ) : visible && url ? (
        <img onError={() => setUrl(null)} src={url} alt={image.name} title={image.name} className="max-h-40 max-w-[16rem] rounded-lg border border-border object-contain" />
      ) : (
        <span className="inline-block h-20 w-28 rounded-lg bg-muted" aria-label={visible ? `Loading ${image.name}` : image.name} />
      )}
    </span>
  )
}

/** The images a stored chat message was sent with (#144). */
export function ChatMessageImages({ images, load, cached, className }: ChatMessageImagesProps) {
  if (images.length === 0) return null
  return (
    <div className={cn('flex flex-wrap justify-end gap-1.5', className)} data-testid="chat-message-images">
      {images.map((image) => (
        <StoredImage key={image.id} image={image} load={load} cached={cached} />
      ))}
    </div>
  )
}
