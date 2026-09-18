/** Tool inputs sometimes carry arrays as JSON strings; parse those, pass anything else through. */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
