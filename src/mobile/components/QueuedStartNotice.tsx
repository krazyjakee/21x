import { useStartQueueStore, describeQueuedStart } from '../stores/start-queue-store'

/** Shown while a start this phone requested waits in the desktop's start queue. */
export function QueuedStartNotice({ taskId }: { taskId: string }) {
  const entry = useStartQueueStore((s) => s.queued[taskId])
  if (!entry) return null
  return (
    <div role="status" className="shrink-0 px-4 py-2 text-xs bg-amber-500/15 text-amber-300 border-b border-border/50">
      {describeQueuedStart(entry)}
    </div>
  )
}
