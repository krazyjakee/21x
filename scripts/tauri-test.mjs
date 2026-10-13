/** Reuse staged Node/SQLite; never rebuild or borrow Electron's root addon. */
import { spawn } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failureMessage = 'Standalone Tauri tests require the pinned staged Node and SQLite. Run pnpm tauri:prepare:native; use --service-proofs only after tauri:prepare:database and --terminal-proofs with the staged node-pty package.'
try {
  const pins = JSON.parse(readFileSync(join(root, 'scripts/tauri-runtime.json'), 'utf8'))
  const node = realpathSync(join(root, 'src-tauri/resources/node', process.platform === 'win32' ? 'node.exe' : 'node'))
  const sqlite = realpathSync(join(root, 'src-tauri/resources/service/node_modules/better-sqlite3'))
  const metadata = JSON.parse(readFileSync(join(sqlite, 'package.json'), 'utf8'))
  if (!lstatSync(node).isFile() || metadata.name !== 'better-sqlite3' || metadata.version !== pins.nativeDependencies['better-sqlite3']) throw new Error()
  // pnpm preserves the script separator; Vitest treats it as end-of-options
  // and would silently ignore reporter/filter flags that follow it.
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  const serviceProofs = args.includes('--service-proofs')
  const productionProofs = args.includes('--production-proofs')
  const terminalProofs = args.includes('--terminal-proofs')
  if (args.some(arg => /^--(?:config|root|workspace|project)(?:=|$)/.test(arg) || ['-c', '-r'].includes(arg))) {
    failureMessage = 'The portable runner does not accept configuration, root, workspace or project overrides.'
    throw new Error()
  }
  const env = { ...process.env, TAURI_NODE_RUNTIME: node, TAURI_SQLITE_MODULE: sqlite,
    TAURI_STANDALONE_SERVICE_PROOFS: serviceProofs ? '1' : '0', TAURI_PRODUCTION_SERVICE_PROOFS: productionProofs ? '1' : '0', TAURI_TERMINAL_PROOFS: terminalProofs ? '1' : '0' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TAURI_DATABASE_SERVICE_ENTRY
  delete env.TAURI_PRODUCTION_SERVICE_ENTRY
  delete env.TAURI_NODE_PTY_MODULE
  if (terminalProofs) {
    const pty = realpathSync(join(root, 'src-tauri/resources/service/node_modules/node-pty'))
    const ptyMetadata = JSON.parse(readFileSync(join(pty, 'package.json'), 'utf8'))
    if (ptyMetadata.name !== 'node-pty' || ptyMetadata.version !== pins.nativeDependencies['node-pty']) throw new Error()
    env.TAURI_NODE_PTY_MODULE = pty
  }
  if (productionProofs) env.TAURI_PRODUCTION_SERVICE_ENTRY = realpathSync(join(root, 'src-tauri/resources/service/production-stdio.mjs'))
  if (serviceProofs) env.TAURI_DATABASE_SERVICE_ENTRY = realpathSync(join(root, 'src-tauri/resources/service/database-stdio.mjs'))
  const child = spawn(node, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.tauri.config.ts',
    ...args.filter(arg => arg !== '--service-proofs' && arg !== '--production-proofs' && arg !== '--terminal-proofs')], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  const stop = signal => child.kill(signal)
  const interrupt = () => stop('SIGINT')
  const terminate = () => stop('SIGTERM')
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
  child.once('error', () => { console.error('Unable to start the staged standalone test runtime.'); process.exitCode = 1 })
  child.once('close', code => {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate)
    process.exitCode = code ?? 1
  })
} catch {
  console.error(failureMessage)
  process.exitCode = 1
}
