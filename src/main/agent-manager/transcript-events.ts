import { electronAgentManagerHost } from './electron-host'
import { notifyStatusTransition as notifyPortableStatusTransition } from './transcript-events-core'

export * from './transcript-events-core'

/** Existing Electron callers retain native notification and click behavior. */
export function notifyStatusTransition(...args: [
  Parameters<typeof notifyPortableStatusTransition>[0],
  Parameters<typeof notifyPortableStatusTransition>[1],
  Parameters<typeof notifyPortableStatusTransition>[2],
  Parameters<typeof notifyPortableStatusTransition>[3],
  Parameters<typeof notifyPortableStatusTransition>[4]
]): void {
  notifyPortableStatusTransition(...args, electronAgentManagerHost().notifications)
}
