import { createContext, useContext, useEffect, useRef, useState, type RefObject } from 'react'
import { captureDesktopRead, getDesktopHost, type DesktopHost } from '@/lib/desktop-api'
import { getCurrentProjectId, useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import type { NativeAttachmentDropReceipt } from '@shared/native-attachment-drop'

/** A workspace owns its nested details/composer as one physical drop target. */
export const NativeAttachmentDropManaged = createContext(false)
interface Options {
  root: RefObject<HTMLElement | null>
  identity: string
  enabled: boolean
  busy: () => boolean
  capacity?: () => number
  consume: (paths: string[], current: () => boolean) => Promise<void>
  error: () => void
  pendingPaths?: readonly string[]
  retirePending?: (paths: readonly string[]) => void
}
interface OwnedReceipt { receipt: NativeAttachmentDropReceipt; retained: boolean }
interface Owner {
  options: () => Options
  alive: boolean
  busy: boolean
  project: string
  invalidate: () => void
  receipts: Map<string, OwnedReceipt>
}
interface Context { owner: Owner; id: string; generation: number | undefined; ready: boolean; current: () => boolean }
let documentOwner: ReturnType<typeof createDocumentOwner> | undefined

function visible(element: HTMLElement): boolean {
  if (!element.isConnected) return false
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.getAttribute('role') === 'dialog' && node.getAttribute('data-state') === 'closed') return false
    if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0' || style.getPropertyValue('content-visibility') === 'hidden') return false
  }
  const boxes = [...element.getClientRects()]
  return boxes.some(box => box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight)
}
function eligible(owner: Owner): boolean {
  const options = owner.options(), root = options.root.current
  if (!owner.alive || !options.enabled || owner.project !== getCurrentProjectId() || document.visibilityState === 'hidden' || !root || !visible(root)) return false
  if (useUIStore.getState().activeModal && !root.closest('[role="dialog"]')) return false
  // A modal owns the physical document; a background task never receives its drop.
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter(visible).every(dialog => dialog.contains(root))
}
function createDocumentOwner(host: DesktopHost) {
  const owners = new Set<Owner>()
  let disposed = false, context: Context | undefined
  let attempted: { owner?: Owner; generation?: number; available: boolean } | undefined
  let unlisten: (() => void) | undefined
  const available = () => !disposed && host === getDesktopHost() && host.connection.status === 'ready'
    && Reflect.get(host, 'hydrationPending') !== true && host.supports('attachments.setNativeDropContext') && host.supports('attachments.onNativeDrop')
  const report = (owner: Owner) => { if (!disposed && owner.alive && eligible(owner)) owner.options().error() }
  const close = async (owner: Owner, entry: OwnedReceipt) => {
    try { await entry.receipt.close(); owner.receipts.delete(entry.receipt.dropId) }
    catch { report(owner) /* Facade retains failed cancelled cleanup for a later explicit intent. */ }
  }
  const retire = (owner: Owner) => {
    const paths = [...owner.receipts.values()].flatMap(entry => entry.receipt.paths)
    if (paths.length) owner.options().retirePending?.(paths)
    for (const entry of owner.receipts.values()) void close(owner, entry)
  }
  const receive = (receipt: NativeAttachmentDropReceipt) => {
    const captured = context, owner = captured?.owner
    if (!captured?.ready || !owner || receipt.contextId !== captured.id || !captured.current()
      || owner.busy || owner.options().busy() || owner.receipts.size >= 16) return
    if (receipt.paths.length > (owner.options().capacity?.() ?? 128)) { report(owner); return }
    const accepting = receipt.accept() // Take local ownership synchronously, before the first await.
    const entry = { receipt, retained: false }
    owner.receipts.set(receipt.dropId, entry)
    owner.busy = true
    return (async () => {
      let keep = false
      try {
        await accepting
        if (!captured.current()) return
        entry.retained = owner.options().pendingPaths !== undefined
        await owner.options().consume(receipt.paths, captured.current)
        keep = entry.retained && captured.current()
      } catch { if (captured.current()) report(owner) }
      finally {
        owner.busy = false
        if (!keep) await close(owner, entry)
      }
    })()
  }
  const refresh = () => {
    if (disposed) return
    const supported = available(), candidates = [...owners].filter(eligible)
    const owner = supported && candidates.length === 1 ? candidates[0] : undefined
    const generation = host.connectionGeneration
    if (attempted && attempted.owner === owner && attempted.generation === generation && attempted.available === supported) return
    attempted = { owner, generation, available: supported }
    const previous = context
    context = undefined // Fence old consumers before registration/cleanup starts.
    if (previous) retire(previous.owner)
    if (!supported) return
    if (!unlisten) unlisten = host.api.attachments.onNativeDrop!(receive)
    const scope = captureDesktopRead()
    const next: Context | undefined = owner ? { owner, id: crypto.randomUUID(), generation, ready: false,
      current: () => next !== undefined && context === next && next.ready && scope.isCurrent() && available() && eligible(owner) } : undefined
    context = next
    // The facade immediately fences older revisions, joins raw retirement and
    // acknowledges this nonce. Never re-register the same owner on a render.
    void host.api.attachments.setNativeDropContext!(next?.id ?? null).then(() => {
      if (next && context === next && scope.isCurrent() && available() && eligible(next.owner)) next.ready = true
    }).catch(() => { if (next && context === next) report(next.owner) })
  }
  const offConnection = host.subscribeConnection(refresh)
  const withdraw = () => {
    for (const owner of owners) { owner.invalidate(); retire(owner) }
    refresh()
  }
  const offProject = useProjectStore.subscribe((state, previous) => {
    if (state.currentProjectId !== previous.currentProjectId) withdraw()
  })
  const offTask = useTaskStore.subscribe((state, previous) => {
    if (state.selectedTaskId !== previous.selectedTaskId) withdraw()
  })
  const offUi = useUIStore.subscribe((state, previous) => {
    if (state.activeModal !== previous.activeModal || state.dashboardPreviewTaskId !== previous.dashboardPreviewTaskId
      || state.editingTaskId !== previous.editingTaskId || state.sidebarView !== previous.sidebarView) withdraw()
  })
  let queued = false
  const schedule = () => {
    if (queued || disposed) return
    queued = true
    queueMicrotask(() => { queued = false; refresh() })
  }
  const observer = new MutationObserver(records => {
    const modalChange = records.some(record => record.type === 'attributes' && record.target instanceof HTMLElement && record.target.matches('[role="dialog"]')
      && (record.attributeName === 'data-state' && (record.oldValue === 'closed' || record.target.getAttribute('data-state') === 'closed')
        || ['hidden', 'inert', 'aria-hidden'].includes(record.attributeName ?? ''))
      || record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => node instanceof HTMLElement
        && (node.matches('[role="dialog"]') || node.querySelector('[role="dialog"]'))))
    if (modalChange) { withdraw(); return }
    if (records.some(record => record.type === 'attributes' && record.target instanceof HTMLElement
      && [...owners].some(owner => !!owner.options().root.current && record.target.contains(owner.options().root.current))
      || record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => node instanceof HTMLElement
        && [...owners].some(owner => !!owner.options().root.current && node.contains(owner.options().root.current))))) schedule()
  })
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'data-state'] })
  const dispose = () => {
    if (disposed) return
    disposed = true; context = undefined
    for (const owner of owners) retire(owner)
    unlisten?.(); offConnection(); offProject(); offTask(); offUi(); observer.disconnect()
    window.removeEventListener('pagehide', dispose)
    document.removeEventListener('visibilitychange', refresh)
    document.removeEventListener('animationend', schedule)
    document.removeEventListener('transitionend', schedule)
    window.removeEventListener('resize', schedule)
    if (documentOwner === api) documentOwner = undefined
  }
  window.addEventListener('pagehide', dispose, { once: true })
  document.addEventListener('visibilitychange', refresh)
  document.addEventListener('animationend', schedule)
  document.addEventListener('transitionend', schedule)
  window.addEventListener('resize', schedule)
  const api = {
    host, dispose,
    add(owner: Owner) { owners.add(owner); refresh(); return () => {
      owner.alive = false; owners.delete(owner); retire(owner)
      if (!owners.size) dispose(); else refresh()
    } },
    releaseUnused(owner: Owner) {
      const paths = owner.options().pendingPaths
      if (!paths) return
      for (const entry of owner.receipts.values()) if (entry.retained && !entry.receipt.paths.some(path => paths.includes(path))) void close(owner, entry)
    }
  }
  return api
}

/** Only ordinary task/draft views register. Browser file paths remain inert. */
export function useNativeAttachmentDrop(options: Options): void {
  const managed = useContext(NativeAttachmentDropManaged)
  const latest = useRef(options)
  latest.current = options
  const owned = useRef<Owner | undefined>(undefined)
  const [intentRevision, setIntentRevision] = useState(0)
  const project = useProjectStore(state => state.currentProjectId)
  useEffect(() => {
    const host = getDesktopHost()
    if (managed || !options.enabled || host.kind !== 'tauri') return
    if (documentOwner?.host !== host) documentOwner?.dispose()
    documentOwner ??= createDocumentOwner(host)
    const owner: Owner = { options: () => latest.current, alive: true, busy: false, project, receipts: new Map(),
      invalidate: () => { if (!owner.alive) return; owner.alive = false; setIntentRevision(value => value + 1) } }
    owned.current = owner
    const release = documentOwner.add(owner)
    return () => { if (owned.current === owner) owned.current = undefined; release() }
  }, [managed, options.identity, options.enabled, project, intentRevision])
  useEffect(() => {
    if (owned.current) documentOwner?.releaseUnused(owned.current)
  }, [options.pendingPaths])
}
if (import.meta.hot) import.meta.hot.dispose(() => documentOwner?.dispose())
