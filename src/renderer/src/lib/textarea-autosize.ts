/**
 * Auto-growing textareas without a full-page layout on every keystroke.
 *
 * The usual `height = 'auto'; height = scrollHeight` reset forces two
 * synchronous layouts per key. WebKit (the Tauri WebView on Linux and macOS)
 * relays out the whole page each time, which made typing in the composers lag
 * by ~50 ms per character. Engines with `field-sizing: content` size the field
 * in CSS (see FIELD_SIZING_CLASS) and this does nothing. Elsewhere, growing
 * only reads `scrollHeight`; the full reset runs only when text got shorter.
 */

/** Add to an auto-growing textarea; pair with a max-height class. */
export const FIELD_SIZING_CLASS = '[field-sizing:content]'

let fieldSizing: boolean | null = null

export function supportsFieldSizing(): boolean {
  fieldSizing ??= typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')
  return fieldSizing
}

const lengths = new WeakMap<HTMLTextAreaElement, number>()

/** Fit the field to its content, up to `maxPx`. */
export function fitTextarea(el: HTMLTextAreaElement, maxPx: number): void {
  if (supportsFieldSizing()) return
  const length = el.value.length
  const previous = lengths.get(el) ?? 0
  lengths.set(el, length)
  if (length < previous || !length) {
    // Text got shorter: the only case that can need a smaller box.
    el.style.height = 'auto'
    if (!length) return
  } else if (el.scrollHeight <= el.clientHeight) {
    return
  }
  el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`
}

/** Return the field to its one-line size, e.g. after sending. */
export function resetTextarea(el: HTMLTextAreaElement): void {
  lengths.delete(el)
  if (!supportsFieldSizing()) el.style.height = 'auto'
}

/** Test seam: forget the cached capability. */
export function resetFieldSizingSupportForTests(): void {
  fieldSizing = null
}
