/** Additive launcher. Existing test:run/test:tauri commands are deliberately unchanged. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostNeutralEnvironment, inspectHostNeutralAbi, readHostNeutralResources } from './host-neutral-runtime.mjs'
import { HOST_NEUTRAL_PROOF_FILES, reviewTestInventory } from './host-neutral-test-policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
try {
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  const receipts = args.filter(arg => arg.startsWith('--run-receipt='))
  if (receipts.length > 1 || receipts.some(arg => arg === '--run-receipt=')) throw new Error('Use one --run-receipt=path')
  const receiptPath = receipts.length ? resolve(root, receipts[0].slice('--run-receipt='.length)) : null
  if (args.some(arg => /^(?:--(?:config|root|workspace)(?:=|$)|-[cr])/.test(arg))) throw new Error('The host-neutral launcher does not accept config/root/workspace overrides')
  const resources = readHostNeutralResources(root), abi = inspectHostNeutralAbi(resources)
  const rows = reviewTestInventory(root)
  const env = { ...hostNeutralEnvironment(), TAURI_HOST_NEUTRAL_RUNNER: '1', TAURI_NODE_RUNTIME: resources.node,
    TAURI_SQLITE_MODULE: resources.sqlite, TAURI_NODE_PTY_MODULE: resources.pty }
  const proofFlags = ['--service-proofs', '--production-proofs', '--terminal-proofs']
  for (const [flag, name] of [['--service-proofs', 'TAURI_STANDALONE_SERVICE_PROOFS'], ['--production-proofs', 'TAURI_PRODUCTION_SERVICE_PROOFS'], ['--terminal-proofs', 'TAURI_TERMINAL_PROOFS']]) env[name] = args.includes(flag) ? '1' : '0'
  if (args.includes('--service-proofs')) env.TAURI_DATABASE_SERVICE_ENTRY = realpathSync(join(root, 'src-tauri/resources/service/database-stdio.mjs'))
  if (args.includes('--production-proofs')) {
    env.TAURI_PRODUCTION_SERVICE_ENTRY = realpathSync(join(root, 'src-tauri/resources/service/production-stdio.mjs'))
    env.TAURI_PRODUCTION_TASK_MCP_ENTRY = realpathSync(join(root, 'src-tauri/resources/service/production-task-mcp.mjs'))
  }
  const nodeTests = args.includes('--node-tests')
  const forwarded = args.filter(arg => !proofFlags.includes(arg) && arg !== '--node-tests' && !arg.startsWith('--run-receipt='))
  const command = nodeTests ? ['--test', '--test-concurrency=1', ...forwarded, ...rows.filter(row => row.framework === 'node:test' && row.cohort === 'host-neutral').map(row => row.file)]
    : [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.host-neutral.config.ts', ...forwarded]
  console.log(`Standalone Node ${abi.node} ABI ${abi.modules}; staged SQLite/PTY verified; ${nodeTests ? 'node:test' : 'Vitest'} host-neutral cohort`)
  const excluded = nodeTests ? [] : Object.entries(HOST_NEUTRAL_PROOF_FILES).filter(([, flag]) => env[flag] !== '1').map(([file, flag]) => ({ file, reason: `Opt-in ${flag} not selected` }))
  if (excluded.length) console.log(`${excluded.length} opt-in proof files excluded; historical Electron cohort runs separately`)
  const signature = file => ({ file: relative(root, file).replaceAll('\\', '/'), sha256: createHash('sha256').update(readFileSync(file)).digest('hex') })
  const git = receiptPath ? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }) : null
  const state = receiptPath ? spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', windowsHide: true }) : null
  const receipt = receiptPath ? { version: 1, kind: 'host-neutral-test-run', startedAt: new Date().toISOString(),
    revision: git?.status === 0 && /^[a-f0-9]{40}\s*$/.test(git.stdout) ? git.stdout.trim() : null,
    workingTreeModified: state?.status === 0 ? state.stdout.length > 0 : null,
    runtime: { node: abi.node, modules: abi.modules, platform: abi.platform, arch: abi.arch },
    artifacts: [resources.node, ...abi.native].map(signature),
    tooling: ['scripts/test-host-neutral.mjs', 'scripts/host-neutral-runtime.mjs', 'scripts/host-neutral-test-policy.mjs', 'test/electron-transition-tests.json', 'test/setup-host-neutral-runtime.ts', 'vitest.host-neutral.config.ts'].map(file => signature(join(root, file))),
    framework: nodeTests ? 'node:test' : 'vitest', proofFlags: Object.fromEntries(proofFlags.map(flag => [flag, args.includes(flag)])),
    callerFiltered: forwarded.some(arg => !arg.startsWith('-') || /^--(?:project|testNamePattern)(?:=|$)/.test(arg)),
    eligibleTests: rows.filter(row => row.cohort === 'host-neutral' && row.framework === (nodeTests ? 'node:test' : 'vitest') && !excluded.some(item => item.file === row.file)).map(({ file, sha256 }) => ({ file, sha256 })),
    exclusions: excluded, historicalElectronFiles: rows.filter(row => row.cohort === 'historical-electron').length,
    scope: 'Framework reports identify executed tests and actual skips. Eligible files are not asserted as executed when caller filters are present. No installed native UI/platform acceptance.' } : null
  const child = spawn(resources.node, command, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM')
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
  child.once('error', () => { console.error('Unable to start host-neutral tests'); process.exitCode = 1 })
  child.once('close', (code, signal) => {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate)
    if (receiptPath) {
      try { writeFileSync(receiptPath, JSON.stringify({ ...receipt, endedAt: new Date().toISOString(), exitCode: code, signal, status: code === 0 ? 'passed' : 'failed' }, null, 2) + '\n') }
      catch { console.error('Unable to write host-neutral run receipt'); process.exitCode = 1; return }
    }
    process.exitCode = code ?? 1
  })
} catch (error) {
  console.error(error instanceof Error && /overrides|Unreviewed|quarantine|cohort/.test(error.message) ? error.message
    : 'Host-neutral tests require physical pinned Node/SQLite/PTY resources; run explicit native preparation first.')
  process.exitCode = 1
}
