/** Build-time feature scope. This is UI policy, never a native authorization check. */
export function embeddedBrowserEnabled(): boolean {
  return import.meta.env.VITE_DESKTOP_HOST !== 'tauri'
}

export function isRetiredBrowserPanel(type: string): boolean {
  return !embeddedBrowserEnabled() && (type === 'browser' || type === 'webpage')
}
