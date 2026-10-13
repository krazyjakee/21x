import { startPieceHost } from './host-runtime'
import { loadBundledPiece } from './piece-registry'
import { installTlsGuard } from './tls-guard'
import type { HostInboundMessage } from './protocol'

/**
 * UtilityProcess or standalone Node IPC entry for the connector piece host.
 * Built as its own electron-vite input (out/main/piece-host.js) and started by
 * createUtilityProcessTransport(). A crash or hang here cannot take down the
 * main process; the client kills and restarts it.
 */

const parentPort = process.parentPort
const standalone = !process.versions.electron && typeof process.send === 'function' && process.connected
if (!parentPort && !standalone) {
  console.error('[piece-host] an owned parent IPC channel is required')
  process.exit(1)
}

// Before any piece code runs: pieces-common turns certificate verification
// off per request, and this keeps it on (see tls-guard.ts).
installTlsGuard()

startPieceHost(
  {
    postMessage: (message) => {
      if (parentPort) parentPort.postMessage(message)
      else if (process.connected) process.send!(message)
    },
    onMessage: (handler) => {
      if (parentPort) parentPort.on('message', (event) => handler(event.data as HostInboundMessage))
      else process.on('message', message => handler(message as HostInboundMessage))
    }
  },
  loadBundledPiece
)

if (standalone) process.once('disconnect', () => process.exit(0))

// A stray rejection inside third-party piece code must not leave the host
// half-alive: exit, and the client reports PieceHostCrashedError. Only the
// error name is logged; piece messages can echo request URLs with credentials.
process.on('unhandledRejection', (reason) => {
  console.error('[piece-host] unhandled rejection:', reason instanceof Error ? reason.name : typeof reason)
  process.exit(70)
})
process.on('uncaughtException', (err) => {
  console.error('[piece-host] uncaught exception:', err.name)
  process.exit(70)
})
