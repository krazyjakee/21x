/**
 * An SDK that is imported on first use and then kept. A failed import is
 * logged once and not retried: every later `ready()` throws.
 */
export function lazySdk<T>(name: string, load: () => Promise<T>): {
  /** The loaded module, or null while loading or after a failed load. */
  current: () => T | null
  ready: () => Promise<T>
} {
  let module: T | null = null
  let loading: Promise<T | null> | null = null
  const start = (): Promise<T | null> => (loading ??= load().then(
    (loaded) => (module = loaded),
    (error) => {
      console.error(`[lazySdk] ${name} failed to load:`, error)
      return null
    }
  ))

  return {
    current: () => module,
    ready: async () => {
      const loaded = await start()
      if (!loaded) throw new Error(`${name} failed to load`)
      return loaded
    }
  }
}
