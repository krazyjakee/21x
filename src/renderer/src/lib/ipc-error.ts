/** The reason alone, without Electron's "Error invoking remote method '…': Error: " wrapper. */
export function ipcErrorReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^(?:Error: )?Error invoking remote method '[^']*': (?:Error: )?/, '')
}
