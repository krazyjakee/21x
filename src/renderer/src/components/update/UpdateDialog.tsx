import { Fragment, useState, useEffect, useMemo, type JSX, type ReactNode } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogDescription } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Markdown } from '@/components/ui/Markdown'
import { updaterApi } from '@/lib/ipc-client'
import { Download, RotateCw, Loader2, ExternalLink, Check, RefreshCw } from 'lucide-react'

/**
 * Release notes come from a GitHub release — text this app does not control —
 * and used to be dropped into `dangerouslySetInnerHTML`. They are now either
 * Markdown (rendered by `Markdown`, which never emits raw HTML) or HTML, which
 * is re-built from an allow-list below: unknown elements are dropped, every
 * attribute except a safe `href` is dropped, and `<script>` / `on*` handlers
 * therefore cannot survive the round trip.
 */
const RELEASE_NOTE_TAGS: Record<string, keyof JSX.IntrinsicElements> = {
  P: 'p', BR: 'br', HR: 'hr', DIV: 'div', SPAN: 'span',
  STRONG: 'strong', B: 'strong', EM: 'em', I: 'em', DEL: 'del', S: 'del',
  CODE: 'code', PRE: 'pre', BLOCKQUOTE: 'blockquote',
  UL: 'ul', OL: 'ol', LI: 'li',
  H1: 'h4', H2: 'h4', H3: 'h5', H4: 'h5', H5: 'h6', H6: 'h6',
  A: 'a'
}

/** Only these tags mean "this is HTML, not Markdown". */
const HTML_NOTES = /<(p|div|ul|ol|li|h[1-6]|br|a|strong|em|b|i|code|pre|blockquote)\b[^>]*>/i

function safeHref(value: string | null): string | null {
  if (!value) return null
  try {
    const { protocol } = new URL(value, 'https://github.com')
    return protocol === 'http:' || protocol === 'https:' ? new URL(value, 'https://github.com').href : null
  } catch {
    return null
  }
}

function toReactNodes(node: Node, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  node.childNodes.forEach((child, index) => {
    const key = `${keyPrefix}-${index}`
    if (child.nodeType === 3 /* text */) {
      if (child.nodeValue) out.push(<Fragment key={key}>{child.nodeValue}</Fragment>)
      return
    }
    if (child.nodeType !== 1 /* element */) return

    const element = child as Element
    const tag = RELEASE_NOTE_TAGS[element.tagName]
    const children = toReactNodes(element, key)

    // <script>, <style>, <iframe>, <img onerror> and friends: not on the
    // allow-list, so neither the element nor its contents are rendered.
    if (!tag) {
      if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') return
      out.push(<Fragment key={key}>{children}</Fragment>)
      return
    }

    if (tag === 'a') {
      const href = safeHref(element.getAttribute('href'))
      out.push(
        <a
          key={key}
          href={href ?? undefined}
          className="text-primary underline"
          onClick={(event) => {
            event.preventDefault()
            if (href) window.electronAPI?.shell?.openExternal(href)
          }}
        >
          {children}
        </a>
      )
      return
    }

    // No attributes are copied over — that is what removes `onclick` & co.
    if (tag === 'br') {
      out.push(<br key={key} />)
      return
    }
    if (tag === 'hr') {
      out.push(<hr key={key} />)
      return
    }
    const Tag = tag as 'p'
    out.push(<Tag key={key}>{children}</Tag>)
  })
  return out
}

/** Renders GitHub release notes without ever handing raw HTML to the DOM. */
export function ReleaseNotes({ notes }: { notes: string }) {
  const content = useMemo(() => {
    if (!HTML_NOTES.test(notes)) return <Markdown size="xs">{notes}</Markdown>
    // DOMParser builds an inert document: nothing in it runs or loads.
    const parsed = new DOMParser().parseFromString(notes, 'text/html')
    return <>{toReactNodes(parsed.body, 'n')}</>
  }, [notes])

  return (
    <div className="text-xs text-foreground prose prose-invert prose-xs max-w-none [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-4 [&_li]:my-0.5">
      {content}
    </div>
  )
}

interface UpdateDialogProps {
  open: boolean
  onClose: () => void
}

interface UpdateState {
  status: string
  version: string | null
  currentVersion: string | null
  releaseNotes: string
  releaseDate: string
  percent: number
  error: string | null
}

export function UpdateDialog({ open, onClose }: UpdateDialogProps) {
  const [state, setState] = useState<UpdateState>({
    status: 'idle',
    version: null,
    currentVersion: null,
    releaseNotes: '',
    releaseDate: '',
    percent: 0,
    error: null
  })

  // Load current version on mount
  useEffect(() => {
    updaterApi.getVersion().then((v) => {
      setState((s) => ({ ...s, currentVersion: v }))
    })
  }, [])

  // Subscribe to updater status events
  useEffect(() => {
    const cleanup = updaterApi.onStatus((data) => {
      setState((prev) => ({
        ...prev,
        status: data.status,
        version: data.version ?? prev.version,
        currentVersion: data.currentVersion ?? prev.currentVersion,
        releaseNotes: data.releaseNotes ?? prev.releaseNotes,
        releaseDate: data.releaseDate ?? prev.releaseDate,
        percent: data.percent ?? prev.percent,
        error: data.error ?? null
      }))
    })
    return cleanup
  }, [])

  // When opened from menu and no update known yet, trigger a check
  useEffect(() => {
    if (open && state.status === 'idle') {
      setState((s) => ({ ...s, status: 'checking', error: null }))
      updaterApi.check().then((result) => {
        // In dev mode (or if check fails synchronously), the main process
        // won't fire updater:status events — handle the response directly.
        if (result && !result.success) {
          setState((s) => s.status === 'checking'
            ? { ...s, status: 'error', error: result.error ?? 'Update check failed' }
            : s
          )
        }
      })
    }
  }, [open])

  const handleDownload = async () => {
    await updaterApi.download()
  }

  const handleInstall = () => {
    updaterApi.install()
  }

  const handleRetry = () => {
    setState((s) => ({ ...s, status: 'checking', error: null }))
    updaterApi.check().then((result) => {
      if (result && !result.success) {
        setState((s) => s.status === 'checking'
          ? { ...s, status: 'error', error: result.error ?? 'Update check failed' }
          : s
        )
      }
    })
  }

  const handleCheckForUpdates = () => {
    setState((s) => ({ ...s, status: 'checking', error: null }))
    updaterApi.check().then((result) => {
      if (result && !result.success) {
        setState((s) => s.status === 'checking'
          ? { ...s, status: 'error', error: result.error ?? 'Update check failed' }
          : s
        )
      }
    })
  }

  const hasUpdate = state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded'

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{hasUpdate ? 'Update Available' : 'Software Update'}</DialogTitle>
          <DialogDescription>
            {state.status === 'checking'
              ? 'Checking for updates\u2026'
              : state.status === 'up-to-date'
                ? 'You\'re up to date!'
                : hasUpdate
                  ? 'A new version of 20x is available'
                  : 'Check for 20x updates'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-4">
            {/* Version comparison */}
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">Current:</span>
              <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                v{state.currentVersion ?? '?'}
              </code>
              {state.version && (
                <>
                  <span className="text-muted-foreground">&rarr;</span>
                  <code className="bg-primary/10 text-primary px-1.5 py-0.5 rounded text-xs font-semibold">
                    v{state.version}
                  </code>
                </>
              )}
            </div>

            {/* Checking spinner */}
            {state.status === 'checking' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking for updates...
              </div>
            )}

            {/* Up to date */}
            {state.status === 'up-to-date' && (
              <div className="text-sm text-green-400 flex items-center gap-1.5">
                <Check className="h-4 w-4" />
                20x is up to date. You&apos;re running the latest version.
              </div>
            )}

            {/* Release notes (may be HTML from GitHub or markdown) — never raw HTML */}
            {hasUpdate && state.releaseNotes && (
              <div className="border border-border rounded-lg p-4 max-h-64 overflow-y-auto">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  What&apos;s New
                </h4>
                <ReleaseNotes notes={state.releaseNotes} />
              </div>
            )}

            {/* Link to full release page */}
            {hasUpdate && state.version && (
              <a
                href={`https://github.com/krazyjakee/21x/releases/tag/v${state.version}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                onClick={(e) => {
                  e.preventDefault()
                  window.electronAPI?.shell?.openExternal(`https://github.com/krazyjakee/21x/releases/tag/v${state.version}`)
                }}
              >
                <ExternalLink className="h-3 w-3" />
                View full release on GitHub
              </a>
            )}

            {/* Download progress */}
            {state.status === 'downloading' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Downloading update...</span>
                  <span>{state.percent}%</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${state.percent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Error message */}
            {state.error && (
              <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                {state.error}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 pt-2">
              {state.status === 'downloaded' ? (
                <Button onClick={handleInstall} className="flex-1">
                  <RotateCw className="h-4 w-4 mr-2" />
                  Install &amp; Restart
                </Button>
              ) : state.status === 'available' ? (
                <Button onClick={handleDownload} className="flex-1">
                  <Download className="h-4 w-4 mr-2" />
                  Download Update
                </Button>
              ) : state.status === 'downloading' ? (
                <Button disabled className="flex-1">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Downloading...
                </Button>
              ) : state.status === 'error' ? (
                <Button onClick={handleRetry} className="flex-1">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Retry
                </Button>
              ) : (state.status === 'idle' || state.status === 'up-to-date') ? (
                <Button onClick={handleCheckForUpdates} variant="outline" className="flex-1">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Check for Updates
                </Button>
              ) : null}
              <Button variant="outline" onClick={onClose}>
                {hasUpdate ? 'Later' : 'Close'}
              </Button>
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
