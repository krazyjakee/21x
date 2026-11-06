/**
 * Call choices kept between runs. Device ids are opaque per-origin handles, never
 * labels or audio. A stored mode, size or corner that is no longer valid falls back
 * quietly. A saved device cannot be checked here: if it has been unplugged, capture
 * fails with a message saying to choose another, because moving to a different
 * microphone without saying so would be worse.
 */
const PREFIX = 'commander-call:'

export function readCallChoice<T extends string>(name: string, choices: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(PREFIX + name)
    return choices.includes(value as T) ? value as T : fallback
  } catch { return fallback }
}

export function readCallText(name: string): string {
  try { return localStorage.getItem(PREFIX + name) ?? '' } catch { return '' }
}

export function rememberCallChoice(name: string, value: string): void {
  try { localStorage.setItem(PREFIX + name, value) } catch { /* The choice still applies to this run. */ }
}
