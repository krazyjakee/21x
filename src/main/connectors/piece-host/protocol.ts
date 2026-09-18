import type { PieceTarget } from '../allowlist'
import type { SerializedPieceError } from './errors'

/**
 * Messages between the main process (PieceHostClient) and the piece host
 * utilityProcess (host-runtime.ts). Everything is structured-clone safe.
 */

export type PieceStoreScope = 'project' | 'flow'

export interface PieceInvocation {
  pieceName: string
  pieceVersion: string
  target: PieceTarget
  /** Resolved per call on the main side; the host never stores it. */
  auth: unknown
  propsValue: Record<string, unknown>
  /** Opaque, non-secret id used for the minimal context.project stub. */
  projectId: string
}

/** main -> host */
export type HostInboundMessage =
  | { kind: 'invoke'; id: number; invocation: PieceInvocation }
  | { kind: 'store-result'; storeId: number; ok: true; value: unknown }
  | { kind: 'store-result'; storeId: number; ok: false; error: SerializedPieceError }

/** host -> main */
export type HostOutboundMessage =
  | { kind: 'ready' }
  | { kind: 'result'; id: number; ok: true; output: unknown }
  | { kind: 'result'; id: number; ok: false; error: SerializedPieceError }
  | {
      kind: 'store'
      storeId: number
      /** The invoke id the request belongs to; main maps it to the instance, the host never names one. */
      callId: number
      op: 'get' | 'put' | 'delete'
      scope: PieceStoreScope
      key: string
      value?: unknown
    }
