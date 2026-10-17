import { isNativeAttachmentDropEvent, NATIVE_ATTACHMENT_DROP, validateNativeDropContext, type NativeAttachmentDropReceipt } from '@shared/native-attachment-drop'
import { ServiceProtocolError } from '@shared/service-protocol'
import { getTauriUiDocument, hasTauriNativeDrops, invokeTauriNativeDrop, type TauriDesktopApi, type TauriUiDocument } from './tauri-desktop-transport'

interface Snapshot { generation: number; ready: boolean }
interface OwnedDrop {
  close(): Promise<void>
  contextId: string
}
/** Facade-local functions are never serialized. One observer owns a view; a
 * missing or ambiguous observer cannot silently retain native selection slots. */
export function createNativeAttachmentDrops(native: TauriDesktopApi, snapshot: () => Snapshot) {
  const observers = new Set<(receipt: NativeAttachmentDropReceipt) => void>()
  const entries = new Set<OwnedDrop>()
  const seen = new Set<string>()
  let revision = 0
  let attemptedDocument: TauriUiDocument | undefined
  let acknowledged: { id: string; revision: number; generation: number; document: TauriUiDocument } | undefined
  const unavailable = () => new ServiceProtocolError('STALE_EPOCH')
  const cleanup = (entry: OwnedDrop) => { void entry.close().catch(() => { /* Entry retains failed raw cleanup for an explicit retry. */ }) }
  const invalidate = () => {
    revision++; acknowledged = undefined
    for (const entry of entries) cleanup(entry)
  }
  const retire = () => {
    invalidate()
    const document = attemptedDocument
    attemptedDocument = undefined
    if (document && getTauriUiDocument(native) === document && hasTauriNativeDrops(native)) {
      // This cleanup-only null intent has a newer private revision even when
      // the preceding registration response has not yet reached this facade.
      void invokeTauriNativeDrop(native, NATIVE_ATTACHMENT_DROP.context,
        { contextId: null, contextRevision: revision }, document).catch(() => {})
    }
  }
  const current = (owned: NonNullable<typeof acknowledged>) => {
    const state = snapshot()
    if (!state.ready || state.generation !== owned.generation || acknowledged !== owned || revision !== owned.revision
      || getTauriUiDocument(native) !== owned.document || !hasTauriNativeDrops(native)) throw unavailable()
  }
  const setContext = (...args: unknown[]): Promise<void> => {
    if (args.length !== 1) return Promise.reject(new ServiceProtocolError('INVALID_ARGUMENTS'))
    try { validateNativeDropContext(args[0]) } catch (error) { return Promise.reject(error) }
    const id = args[0]
    invalidate() // synchronous, before any registration/retirement await
    const mine = revision, state = snapshot(), document = getTauriUiDocument(native)
    if (!state.ready || !document || !hasTauriNativeDrops(native)) return Promise.reject(unavailable())
    attemptedDocument = document
    const pending = [...entries].map(entry => entry.close())
    const raw = invokeTauriNativeDrop(native, NATIVE_ATTACHMENT_DROP.context, { contextId: id, contextRevision: mine }, document)
    return Promise.all([raw, ...pending]).then(() => {
      const now = snapshot()
      if (!now.ready || now.generation !== state.generation || mine !== revision || getTauriUiDocument(native) !== document) throw unavailable()
      if (id !== null) acknowledged = { id, revision: mine, generation: state.generation, document }
    })
  }
  function receive(value: unknown): void {
    if (!isNativeAttachmentDropEvent(value)) return
    const document = getTauriUiDocument(native)
    if (!document || value.engineEpoch !== document.engineEpoch || value.leaseId !== document.leaseId) return
    if (seen.has(value.drop.dropId)) return // never close a previously accepted receipt on replay
    if (seen.size >= 4096) {
      void invokeTauriNativeDrop(native, NATIVE_ATTACHMENT_DROP.close, { dropId: value.drop.dropId, contextId: value.drop.contextId }, document).catch(() => {})
      return
    }
    seen.add(value.drop.dropId)
    const { dropId, contextId } = value.drop
    const context = acknowledged
    let localTaken = false, closing = false, retired = false
    let rawAccept: Promise<void> | undefined, rawClose: Promise<void> | undefined
    const entry: OwnedDrop = { contextId, close: () => {
      closing = true
      if (retired) return Promise.resolve()
      if (rawClose) return rawClose
      // Admit ownership before calling native. Reentrant close cannot lose the
      // in-flight accept or acknowledge before its actual receipt settles.
      rawClose = Promise.resolve().then(async () => {
        await rawAccept?.catch(() => {})
        await invokeTauriNativeDrop(native, NATIVE_ATTACHMENT_DROP.close, { dropId, contextId }, document)
        retired = true; entries.delete(entry)
      }).catch(error => { rawClose = undefined; throw error })
      return rawClose
    } }
    entries.add(entry)
    const guard = () => {
      if (closing || !context || context.id !== contextId) throw unavailable()
      current(context)
    }
    const receipt: NativeAttachmentDropReceipt = Object.freeze({
      dropId, contextId, paths: Object.freeze([...value.drop.paths]) as unknown as string[],
      accept: (): Promise<void> => {
        localTaken = true // required synchronously, before returning a promise
        if (closing) return Promise.reject(unavailable())
        if (rawAccept) return rawAccept
        rawAccept = Promise.resolve().then(async () => {
          guard()
          await invokeTauriNativeDrop(native, NATIVE_ATTACHMENT_DROP.accept, { dropId, contextId }, document)
          guard()
        })
        void rawAccept.catch(() => { cleanup(entry) }) // do not await close inside accept's own raw receipt
        return rawAccept
      },
      close: () => entry.close()
    })
    try {
      guard()
      if (entries.size > 16 || observers.size !== 1) throw unavailable()
      const observer = [...observers][0]
      void Promise.resolve(observer(receipt)).catch(() => { cleanup(entry) })
    } catch { cleanup(entry) }
    if (!localTaken) cleanup(entry)
  }
  return {
    supported: () => hasTauriNativeDrops(native), setContext, receive, retire,
    subscribe(observer: (receipt: NativeAttachmentDropReceipt) => void): () => void {
      if (typeof observer !== 'function') throw new ServiceProtocolError('INVALID_ARGUMENTS')
      observers.add(observer)
      return () => { observers.delete(observer); retire() }
    },
    dispose() { retire(); observers.clear() }
  }
}
