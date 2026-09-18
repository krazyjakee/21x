import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { findTranscriptMatches, type TranscriptItem } from '@shared/transcript/transcript-items'

/** Find-in-transcript state, shared by the desktop panel and the mobile page. */
export function useTranscriptSearch(items: TranscriptItem[]) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeResult, setActiveResult] = useState(0)
  const normalizedQuery = query.trim().toLowerCase()
  const resultIndexes = useMemo(() => findTranscriptMatches(items, normalizedQuery), [items, normalizedQuery])
  const activeItemIndex = resultIndexes[activeResult] ?? -1

  useEffect(() => {
    setActiveResult(0)
  }, [normalizedQuery])

  useEffect(() => {
    if (activeResult >= resultIndexes.length) {
      setActiveResult(Math.max(resultIndexes.length - 1, 0))
    }
  }, [activeResult, resultIndexes.length])

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  const open = useCallback(() => {
    setIsOpen(true)
    focusInput()
  }, [focusInput])

  const toggle = useCallback(() => {
    setIsOpen((current) => {
      if (!current) focusInput()
      return !current
    })
  }, [focusInput])

  const close = useCallback(() => {
    setQuery('')
    setIsOpen(false)
    setActiveResult(0)
  }, [])

  const goToResult = useCallback((direction: 1 | -1) => {
    if (resultIndexes.length === 0) return
    setActiveResult((current) => (current + direction + resultIndexes.length) % resultIndexes.length)
  }, [resultIndexes.length])

  const counter = normalizedQuery ? `${resultIndexes.length ? activeResult + 1 : 0}/${resultIndexes.length}` : '0/0'

  return { inputRef, isOpen, query, setQuery, normalizedQuery, resultCount: resultIndexes.length, activeItemIndex, counter, open, toggle, close, goToResult }
}

export type TranscriptSearch = ReturnType<typeof useTranscriptSearch>
