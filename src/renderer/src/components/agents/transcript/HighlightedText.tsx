import type { ReactNode } from 'react'

export function HighlightedText({ text, query }: { text: string; query?: string }) {
  const normalizedQuery = query?.trim()
  if (!normalizedQuery) return <>{text}</>

  const lowerText = text.toLowerCase()
  const lowerQuery = normalizedQuery.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let matchIndex = lowerText.indexOf(lowerQuery)

  while (matchIndex !== -1) {
    if (matchIndex > cursor) parts.push(text.slice(cursor, matchIndex))
    const match = text.slice(matchIndex, matchIndex + normalizedQuery.length)
    parts.push(
      <mark key={`${matchIndex}-${match}`} className="rounded-sm bg-yellow-300/80 px-0.5 text-black">
        {match}
      </mark>
    )
    cursor = matchIndex + normalizedQuery.length
    matchIndex = lowerText.indexOf(lowerQuery, cursor)
  }

  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}
