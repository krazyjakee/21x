/** Explicit historical adapters only. Never imported by production/Node tests. */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostNeutralEnvironment } from './host-neutral-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
try {
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  if (args.some(arg => /^(?:--(?:config|root|workspace)(?:=|$)|-[cr])/.test(arg))) throw new Error('Historical tests do not accept configuration overrides')
  const require = createRequire(join(root, 'package.json')), electron = require('electron')
  const version = require('electron/package.json').version
  if (typeof electron !== 'string') throw new Error('Run the historical launcher from ordinary Node')
  const env = { ...hostNeutralEnvironment(), ELECTRON_RUN_AS_NODE: '1' }
  const probe = spawnSync(electron, ['-e', `if(process.versions.electron!==${JSON.stringify(version)})process.exit(1);const Database=require('better-sqlite3'),db=new Database(':memory:');db.exec('CREATE TABLE receipt(value)');db.close();process.stdout.write(JSON.stringify({node:process.version,electron:process.versions.electron,modules:process.versions.modules}));`], { cwd: root, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 65536, windowsHide: true })
  if (probe.error || probe.status !== 0) throw new Error('Prepare historical Electron SQLite before running this cohort')
  const identity = JSON.parse(probe.stdout)
  if (identity.electron !== version || !/^[1-9][0-9]+$/.test(identity.modules)) throw new Error('Historical runtime identity mismatch')
  console.log(`Historical Electron ${version} / Node ${identity.node} ABI ${identity.modules}; root SQLite load verified; explicit reviewed cohort`)
  const child = spawn(electron, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.electron-transition.config.ts', ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM')
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
  child.once('error', () => { console.error('Unable to start historical tests'); process.exitCode = 1 })
  child.once('close', code => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); process.exitCode = code ?? 1 })
} catch { console.error('Historical cohort requires the installed Electron runtime and its prepared SQLite addon; no standalone fallback.'); process.exitCode = 1 }
