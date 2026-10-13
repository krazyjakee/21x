import type { CallMedia } from '@shared/commander-call'

/** One visible tile reads the shared analyser directly. No frame writes reach a store. */
export function bindPresenceLevel(element: HTMLElement, media: CallMedia, kind: 'input' | 'output'): () => void {
  let frame: number | null = null, stopped = false, inView = typeof IntersectionObserver === 'undefined'
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const visible = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
    inView = !!entries[0]?.isIntersecting
    if (inView) start()
    else pause()
  })
  const reset = () => { element.style.setProperty('--commander-level', '0') }
  const pause = () => { if (frame !== null) cancelAnimationFrame(frame); frame = null; reset() }
  const tick = () => {
    frame = null
    if (stopped || document.hidden || !element.isConnected) { reset(); return }
    const level = Math.max(0, Math.min(1, kind === 'output' ? media.outputLevel() : media.inputLevel()))
    const value = reduced.matches ? level > .45 ? 1 : level > .08 ? .5 : 0 : level
    element.style.setProperty('--commander-level', String(value))
    frame = requestAnimationFrame(tick)
  }
  function start() { if (!stopped && inView && !document.hidden && frame === null) frame = requestAnimationFrame(tick) }
  const visibility = () => document.hidden ? pause() : start()
  document.addEventListener('visibilitychange', visibility)
  if (visible) visible.observe(element)
  else start()
  return () => { stopped = true; visible?.disconnect(); document.removeEventListener('visibilitychange', visibility); pause() }
}
