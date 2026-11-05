/**
 * Call choices kept between runs. Device ids are opaque per-origin handles, never
 * labels or audio. A stored value that is no longer valid falls back quietly: the
 * choice was a convenience and must not stop a call from starting.
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
