import { fileURLToPath } from 'url'
import { resolve } from 'path'

/**
 * True when `url` is the app itself: the dev server's exact origin, or the
 * packaged renderer's index.html. Anything else loaded in the main window
 * would get the full preload API, so prefix checks are not enough —
 * `http://localhost:@evil.com/` starts with `http://localhost:`.
 */
export function isMainWindowUrl(url: string, rendererDevUrl: string | null, rendererIndexPath: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (rendererDevUrl) {
    return parsed.origin === new URL(rendererDevUrl).origin
  }
  if (parsed.protocol !== 'file:') return false
  try {
    return resolve(fileURLToPath(parsed)) === resolve(rendererIndexPath)
  } catch {
    return false
  }
}
