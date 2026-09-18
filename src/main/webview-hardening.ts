import type { WebPreferences } from 'electron'

/**
 * `webviewTag` is on for the canvas browser panels, and a <webview> carries its
 * own `preload` / `nodeintegration` attributes — set by whatever markup created
 * it. A renderer-side injection could therefore hand a guest page a preload
 * script or Node, which is a straight path out of the sandbox.
 *
 * Nothing in this app asks for a webview preload, so `will-attach-webview`
 * strips the attributes rather than validating them.
 */
export function hardenWebviewPreferences(
  webPreferences: WebPreferences & { preloadURL?: string },
  params?: Record<string, unknown>
): void {
  // `preload` is what Electron reads today; `preloadURL` is the older field that
  // still arrives on some versions. Delete both, then the attributes that fed them.
  delete webPreferences.preload
  delete webPreferences.preloadURL
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true

  // The raw attributes are strings ("false" is truthy), so they are deleted
  // rather than overwritten — absent means Electron's secure default.
  if (params) {
    for (const attribute of [
      'preload',
      'preloadurl',
      'nodeintegration',
      'nodeintegrationinsubframes',
      'webviewtag',
      'contextisolation'
    ]) {
      delete params[attribute]
    }
  }
}
