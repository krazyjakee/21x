import type { DesktopApi } from '@shared/desktop-api'
import type { DesktopClientState } from './desktop-client'

export class DesktopUnavailableError extends Error {
  readonly code = 'DESKTOP_UNAVAILABLE'
  constructor(readonly capability: string) { super('This feature is unavailable in this desktop host.'); this.name = 'DesktopUnavailableError' }
}

export interface DesktopHost {
  readonly kind: 'electron' | 'tauri' | 'unavailable'
  readonly api: DesktopApi
  readonly connection: Readonly<DesktopClientState>
  supports: (path: string) => boolean
  subscribeConnection: (listener: () => void) => () => void
  reconnect?: () => Promise<void>
  dispose: () => void
}

function electronBridge(): DesktopApi | undefined {
  // The only production reader of the Electron preload. Native bootstraps
  // install their host before importing any production stores/components.
  return typeof window === 'undefined' ? undefined : window.electronAPI
}
export function createElectronHost(read = electronBridge): DesktopHost {
  return {
    kind: 'electron',
    get api(): DesktopApi { return read() as DesktopApi },
    get connection(): Readonly<DesktopClientState> { return { status: read() ? 'ready' : 'disconnected', engineEpoch: null } },
    supports: path => typeof readPath(read(), path) === 'function',
    subscribeConnection: () => { throw new DesktopUnavailableError('Electron connection notifications') },
    dispose: () => {}
  }
}
function readPath(value: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object') return undefined
    value = Reflect.get(value, key)
  }
  return value
}
let host: DesktopHost = createElectronHost()
/** Stable, typed facade; reads stay late-bound so existing bridge mocks behave identically. */
export const desktopApi: DesktopApi = new Proxy({} as DesktopApi, {
  get(_target, key) {
    const api = host.api
    if (!api) return undefined
    const value = Reflect.get(api, key)
    return typeof value === 'function' ? value.bind(api) : value
  }
})
export function getDesktopHost(): DesktopHost { return host }
export function desktopSupports(path: string): boolean { return host.supports(path) }
export function installDesktopHost(next: DesktopHost): () => void {
  const previous = host
  host = next
  let released = false
  return () => { if (released) return; released = true; if (host === next) host = previous; next.dispose() }
}

/** Legacy browser access belongs only to the shipping Electron host. */
export function electronBrowserApi(): Window['electronAPI']['browser'] | undefined {
  if (host.kind !== 'electron') return undefined
  return readPath(host.api, 'browser') as Window['electronAPI']['browser'] | undefined
}
