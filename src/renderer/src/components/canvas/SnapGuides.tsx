import { useCanvasStore } from '@/stores/canvas-store'

/** Canvas-space half-length of a guide line — long enough to always span the
 *  viewport at any zoom, so the guides don't depend on the viewport at all. */
const GUIDE_EXTENT = 50_000
const GUIDE_COLOR = 'rgba(30,150,235,0.25)'

/**
 * Subscribes to `snapGuides` itself rather than taking them as a prop: guides
 * appear/disappear mid-drag, and a prop would force InfiniteCanvas (and with
 * it every panel) to re-render. The store bails out on structurally equal
 * guide arrays, so a drag that stays snapped writes nothing at all.
 */
export function SnapGuides() {
  const guides = useCanvasStore((s) => s.snapGuides)
  if (guides.length === 0) return null

  return (
    <>
      {guides.map((guide, i) => (
        <div
          key={`${guide.axis}-${guide.position}-${i}`}
          className="absolute pointer-events-none"
          style={
            guide.axis === 'x'
              ? { left: guide.position, top: -GUIDE_EXTENT, width: 1, height: GUIDE_EXTENT * 2, background: GUIDE_COLOR }
              : { left: -GUIDE_EXTENT, top: guide.position, width: GUIDE_EXTENT * 2, height: 1, background: GUIDE_COLOR }
          }
        />
      ))}
    </>
  )
}
