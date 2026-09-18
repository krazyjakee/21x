import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { getTranscriptItemContentLength, type TranscriptItem } from '@shared/transcript/transcript-items'

interface AutoScrollOptions {
  items: TranscriptItem[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
  scrollRef: RefObject<HTMLDivElement | null>
  /** Search result to center on; while one is active, auto-scroll pauses. */
  activeSearchItemIndex: number
  /** Distance from the bottom (px) still treated as "at the bottom". */
  bottomThreshold: number
}

/**
 * Sticks the virtualized transcript to the bottom while the user is there:
 * new rows and content streaming into the last row both scroll it into view.
 */
export function useTranscriptAutoScroll({ items, virtualizer, scrollRef, activeSearchItemIndex, bottomThreshold }: AutoScrollOptions) {
  const atBottomRef = useRef(true)
  const scrollRafRef = useRef<number | null>(null)
  const autoScrollRafRef = useRef<number | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const itemCount = items.length
  const lastItemContentLength = useMemo(() => getTranscriptItemContentLength(items[items.length - 1]), [items])

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      const el = scrollRef.current
      if (!el) return
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < bottomThreshold
      atBottomRef.current = isAtBottom
      setShowScrollToBottom(!isAtBottom)
    })
  }, [bottomThreshold, scrollRef])

  const scrollToBottom = useCallback(() => {
    if (itemCount > 0) {
      virtualizer.scrollToIndex(itemCount - 1, { align: 'end' })
      atBottomRef.current = true
      setShowScrollToBottom(false)
    }
  }, [itemCount, virtualizer])

  useEffect(() => {
    if (activeSearchItemIndex >= 0) return
    if (itemCount > 0 && atBottomRef.current) {
      if (autoScrollRafRef.current !== null) cancelAnimationFrame(autoScrollRafRef.current)
      autoScrollRafRef.current = requestAnimationFrame(() => {
        autoScrollRafRef.current = null
        if (!atBottomRef.current) return
        virtualizer.scrollToIndex(itemCount - 1, { align: 'end' })
      })
    }
    return () => {
      if (autoScrollRafRef.current !== null) {
        cancelAnimationFrame(autoScrollRafRef.current)
        autoScrollRafRef.current = null
      }
    }
  }, [activeSearchItemIndex, lastItemContentLength, itemCount, virtualizer])

  useEffect(() => {
    if (activeSearchItemIndex < 0) return
    virtualizer.scrollToIndex(activeSearchItemIndex, { align: 'center' })
    atBottomRef.current = false
    setShowScrollToBottom(true)
  }, [activeSearchItemIndex, virtualizer])

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current)
      if (autoScrollRafRef.current !== null) cancelAnimationFrame(autoScrollRafRef.current)
    }
  }, [])

  return { handleScroll, scrollToBottom, showScrollToBottom }
}
