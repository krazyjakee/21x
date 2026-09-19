import { useEffect, useState } from 'react'
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
  const [url, setUrl] = useState<string | null | undefined>(() => cached?.(image.id))
  useEffect(() => {
    if (url) return
    let live = true
    void load(image.id).then((next) => { if (live) setUrl(next) })
    return () => { live = false }
  }, [image.id, load, url])

  if (url === null) {
    return (
      <span className="inline-flex h-20 w-28 flex-col items-center justify-center gap-1 rounded-lg border border-border bg-muted text-[10px] text-muted-foreground">
        <ImageOff className="size-4" aria-hidden="true" />
        <span className="max-w-full truncate px-1">{image.name}</span>
      </span>
    )
  }
  if (!url) return <span className="inline-block h-20 w-28 animate-pulse rounded-lg bg-muted" aria-label={`Loading ${image.name}`} />
  return <img src={url} alt={image.name} title={image.name} className="max-h-40 max-w-[16rem] rounded-lg border border-border object-contain" />
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
