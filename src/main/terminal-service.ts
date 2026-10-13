import { TerminalServiceCore } from './terminal-service-core'
import { createNodePty, resolveShell, terminalProcessCwd } from './terminal-process'

/** Standalone host must resolve node-pty from its ABI-matched staged resources. */
export function createStandaloneTerminalService(pty: Pick<typeof import('node-pty'), 'spawn'>): TerminalServiceCore {
  if (process.versions.electron) throw new Error('Standalone terminals require the owning Node runtime')
  return new TerminalServiceCore({ resolveShell, create: options => createNodePty(options, pty), getCwd: terminalProcessCwd })
}
