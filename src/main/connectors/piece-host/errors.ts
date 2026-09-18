/**
 * Typed errors for the connector piece host (issue #12).
 *
 * Errors cross the utilityProcess boundary as plain objects
 * ({@link SerializedPieceError}) and are rebuilt on the main side, so callers
 * can rely on `instanceof` and `code` no matter which side raised them.
 */

export type PieceErrorCode =
  | 'PIECE_HOST_CRASHED'
  | 'PIECE_TIMEOUT'
  | 'PIECE_CANCELLED'
  | 'PIECE_UNSUPPORTED_CONTEXT'
  | 'PIECE_NOT_ALLOWED'
  | 'PIECE_EXECUTION_FAILED'
  | 'CONNECTOR_SSRF_BLOCKED'

export abstract class PieceHostError extends Error {
  abstract readonly code: PieceErrorCode
}

/** The host process exited or failed while a call was in flight. It is restarted on the next call. */
export class PieceHostCrashedError extends PieceHostError {
  readonly code = 'PIECE_HOST_CRASHED' as const
  constructor(readonly exitCode: number | null = null, detail?: string) {
    super(`The connector piece host stopped unexpectedly${exitCode === null ? '' : ` (exit code ${exitCode})`}${detail ? `: ${detail}` : ''}`)
    this.name = 'PieceHostCrashedError'
  }
}

/** A call ran past its timeout. The host was killed and will be restarted. */
export class PieceTimeoutError extends PieceHostError {
  readonly code = 'PIECE_TIMEOUT' as const
  constructor(readonly timeoutMs: number) {
    super(`The connector piece did not finish within ${timeoutMs} ms`)
    this.name = 'PieceTimeoutError'
  }
}

/** The caller cancelled the call. The host was killed and will be restarted. */
export class PieceCancelledError extends PieceHostError {
  readonly code = 'PIECE_CANCELLED' as const
  constructor() {
    super('The connector piece call was cancelled')
    this.name = 'PieceCancelledError'
  }
}

/**
 * The piece used a context feature 20x does not provide (flow control,
 * pause/resume, webhook URLs, platform file storage, connections lookup, ...).
 * Never a silent no-op: the call fails even if the piece swallowed the throw.
 */
export class UnsupportedPieceContext extends PieceHostError {
  readonly code = 'PIECE_UNSUPPORTED_CONTEXT' as const
  constructor(readonly feature: string) {
    super(`Connector pieces cannot use context.${feature} in 21x`)
    this.name = 'UnsupportedPieceContext'
  }
}

/** The package, version, action or trigger is not in the connector allowlist. */
export class PieceNotAllowedError extends PieceHostError {
  readonly code = 'PIECE_NOT_ALLOWED' as const
  constructor(
    readonly pieceName: string,
    readonly detail: string
  ) {
    super(`Connector piece ${pieceName} is not allowed: ${detail}`)
    this.name = 'PieceNotAllowedError'
  }
}

/** The piece itself threw. The message comes from third-party code; redact credentials before showing it. */
export class PieceExecutionError extends PieceHostError {
  readonly code = 'PIECE_EXECUTION_FAILED' as const
  constructor(
    message: string,
    readonly pieceErrorName?: string
  ) {
    super(message)
    this.name = 'PieceExecutionError'
  }
}

/** A URL-valued prop pointed somewhere pieces may not reach (see ../ssrf.ts). */
export class SsrfBlockedError extends PieceHostError {
  readonly code = 'CONNECTOR_SSRF_BLOCKED' as const
  constructor(
    readonly prop: string,
    readonly reason: string
  ) {
    super(`Connector prop "${prop}" was blocked: ${reason}`)
    this.name = 'SsrfBlockedError'
  }
}

export interface SerializedPieceError {
  code: PieceErrorCode
  message: string
  name?: string
  feature?: string
  pieceName?: string
  detail?: string
  prop?: string
  reason?: string
  timeoutMs?: number
  exitCode?: number | null
}

export function serializePieceError(err: unknown): SerializedPieceError {
  if (err instanceof UnsupportedPieceContext) return { code: err.code, message: err.message, feature: err.feature }
  if (err instanceof PieceNotAllowedError) {
    return { code: err.code, message: err.message, pieceName: err.pieceName, detail: err.detail }
  }
  if (err instanceof SsrfBlockedError) return { code: err.code, message: err.message, prop: err.prop, reason: err.reason }
  if (err instanceof PieceTimeoutError) return { code: err.code, message: err.message, timeoutMs: err.timeoutMs }
  if (err instanceof PieceHostCrashedError) return { code: err.code, message: err.message, exitCode: err.exitCode }
  if (err instanceof PieceHostError) return { code: err.code, message: err.message }
  if (err instanceof Error) return { code: 'PIECE_EXECUTION_FAILED', message: err.message, name: err.name }
  return { code: 'PIECE_EXECUTION_FAILED', message: typeof err === 'string' ? err : 'Connector piece failed' }
}

export function deserializePieceError(e: SerializedPieceError): PieceHostError {
  switch (e.code) {
    case 'PIECE_UNSUPPORTED_CONTEXT':
      return new UnsupportedPieceContext(e.feature ?? 'unknown')
    case 'PIECE_NOT_ALLOWED':
      return new PieceNotAllowedError(e.pieceName ?? 'unknown', e.detail ?? e.message)
    case 'CONNECTOR_SSRF_BLOCKED':
      return new SsrfBlockedError(e.prop ?? 'unknown', e.reason ?? e.message)
    case 'PIECE_TIMEOUT':
      return new PieceTimeoutError(e.timeoutMs ?? 0)
    case 'PIECE_CANCELLED':
      return new PieceCancelledError()
    case 'PIECE_HOST_CRASHED':
      return new PieceHostCrashedError(e.exitCode ?? null)
    default:
      return new PieceExecutionError(e.message, e.name)
  }
}
