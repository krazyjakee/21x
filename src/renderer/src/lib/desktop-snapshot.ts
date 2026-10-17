import { ServiceProtocolError } from '@shared/service-protocol'
import { captureDesktopRead } from './desktop-api'

/** Coalesce reads, then retry a snapshot crossed by an event/accepted write.
 * No event journal or mutation replay: eight busy reads leave recovery fenced.
 */
export function createDesktopSnapshotReader<T>(options: {
  read: () => Promise<T>
  apply: (snapshot: T) => void
  start?: () => void
  fail: (error: unknown) => void
}): { refresh: () => Promise<void>; invalidate: () => void; dispose: () => void } {
  let revision = 0
  let active: { scope: ReturnType<typeof captureDesktopRead>; promise: Promise<void>; reading: boolean } | undefined
  return {
    invalidate() { revision++ },
    dispose() { revision++; active = undefined },
    refresh() {
      if (active?.reading && active.scope.isCurrent()) return active.promise
      const scope = captureDesktopRead()
      const run = { scope, promise: Promise.resolve(), reading: true }
      active = run
      run.promise = Promise.resolve().then(async () => {
        for (let attempt = 0; attempt < 8; attempt++) {
          scope.assertCurrent()
          if (active !== run) throw new ServiceProtocolError('STALE_EPOCH')
          const observed = revision
          const snapshot = await options.read()
          scope.assertCurrent()
          if (active !== run) throw new ServiceProtocolError('STALE_EPOCH')
          if (observed !== revision) continue
          run.reading = false
          options.apply(snapshot)
          return
        }
        throw new ServiceProtocolError('BACKPRESSURE')
      }).catch(error => {
        run.reading = false
        if (active === run && scope.isSameConnection()) options.fail(error)
        throw error
      }).finally(() => { if (active === run) active = undefined })
      options.start?.()
      return run.promise
    }
  }
}
