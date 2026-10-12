/** Saved metadata remains in the canvas; mounting this view never loads its URL. */
export function RetiredBrowserPanelContent() {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
      <div>
        <p>Embedded browsing has been retired.</p>
        <p className="mt-2 text-xs">Your saved panel and recordings are preserved.</p>
      </div>
    </div>
  )
}
