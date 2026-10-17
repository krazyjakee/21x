/** Default is filesystem-only detection. --prepare builds; only --live runs providers. */
import { constants } from 'node:fs'
import { access, lstat, stat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const names = { opencode: 'opencode', 'claude-code': 'claude', codex: 'codex', cursor: 'cursor-agent', pi: 'pi' }
const accountFiles = home => ({ opencode: join(home, '.local/share/opencode/auth.json'),
  'claude-code': join(home, '.claude/.credentials.json'), codex: join(home, '.codex/auth.json'), pi: join(home, '.pi/agent/auth.json') })
async function json(file) {
  if ((await stat(file)).size > 1_048_576) throw new Error('ACCOUNT_METADATA_TOO_LARGE')
  return JSON.parse(await readFile(file, 'utf8'))
}
export async function detectBackends({ home = homedir(), path = process.env.PATH || '' } = {}) {
  const files = accountFiles(home), report = []
  for (const [backend, command] of Object.entries(names)) {
    let executable = null
    const directories = [...path.split(delimiter).filter(Boolean), join(home, '.local/bin'), join(home, '.opencode/bin'), join(home, '.volta/bin'), join(home, '.npm-global/bin')]
    for (const directory of directories) {
      for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
        const candidate = join(directory, command + suffix)
        try { await access(candidate, constants.X_OK); if ((await lstat(candidate)).isFile() || (await lstat(candidate)).isSymbolicLink()) { executable = candidate; break } } catch { /* absent */ }
      }
      if (executable) break
    }
    let auth = 'unknown', oauthProviders = []
    if (files[backend]) {
      try {
        const metadata = await json(files[backend])
        if (backend === 'codex') auth = metadata.auth_mode === 'chatgpt' && metadata.tokens ? 'oauth-present-unverified' : 'subscription-not-detected'
        else if (backend === 'claude-code') auth = metadata.claudeAiOauth?.accessToken ? 'oauth-present-unverified' : 'subscription-not-detected'
        else {
          oauthProviders = Object.entries(metadata).filter(([, value]) => value && typeof value === 'object' && value.type === 'oauth').filter(([provider]) => /^[a-z][a-z0-9_-]{0,63}$/.test(provider)).map(([provider]) => provider)
          auth = oauthProviders.length ? 'oauth-present-unverified' : 'subscription-not-detected'
        }
      } catch { auth = 'metadata-unavailable' }
    }
    report.push({ backend, installed: !!executable, executable, auth, oauthProviders })
  }
  return report
}

export function proofEnvironment(profileRoot, executableDirectories, runtime) {
  // No inherited billing keys, SDK options, hooks, agent harness flags or live app profile.
  return { HOME: profileRoot, USERPROFILE: profileRoot, XDG_CONFIG_HOME: join(profileRoot, '.config'),
    XDG_DATA_HOME: join(profileRoot, '.local/share'), XDG_CACHE_HOME: join(profileRoot, '.cache'),
    APPDATA: join(profileRoot, 'AppData/Roaming'), LOCALAPPDATA: join(profileRoot, 'AppData/Local'),
    PATH: [dirname(runtime), ...executableDirectories].join(delimiter), LANG: 'C.UTF-8',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
    TWENTYX_LIVE_BACKEND_PROOF: 'explicit-live' }
}

export async function validateProofProfile(profileRoot, backend) {
  const credential = accountFiles(profileRoot)[backend]
  let count = 0
  const keyFree = value => {
    if (!value || typeof value !== 'object') return true
    return Object.entries(value).every(([key, child]) =>
      !(/api[_-]?key/i.test(key) && child !== null && child !== '') && keyFree(child))
  }
  async function visit(directory, depth = 0) {
    if (depth > 8) throw new Error('PROOF_PROFILE_BOUND_EXCEEDED')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 64 || entry.isSymbolicLink()) throw new Error('PROOF_REQUIRES_FRESH_KEY_FREE_PROFILE')
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await visit(file, depth + 1)
      else {
        // Only copied auth metadata may precede a one-shot run. No settings,
        // plugins, model overrides, histories or links to a live account profile.
        if (!entry.isFile() || credential && file !== credential || !credential && !file.endsWith('.json') || !keyFree(await json(file))) throw new Error('PROOF_REQUIRES_FRESH_KEY_FREE_PROFILE')
      }
    }
  }
  await visit(profileRoot)
}

export async function prepareBackendProof() {
  const resources = join(root, 'src-tauri/resources'), service = join(resources, 'service')
  const pins = await json(join(root, 'scripts/tauri-runtime.json'))
  const packages = { ...pins.sdkDependencies }, exports = new Map()
  for (const [name, version] of Object.entries(packages)) {
    const metadata = await json(join(service, 'node_modules', name, 'package.json'))
    if (metadata.name !== name || metadata.version !== version) throw new Error('STAGED_SDK_PIN_MISMATCH')
    for (const [key, target] of Object.entries(metadata.exports ?? {})) {
      const destination = typeof target === 'string' ? target : target.import ?? target.default
      if (typeof destination === 'string' && destination.startsWith('./') && !destination.includes('..', 2)) {
        exports.set(name + (key === '.' ? '' : key.slice(1)), pathToFileURL(join(service, 'node_modules', name, destination)).href)
      }
    }
  }
  const external = id => isBuiltin(id) || Object.keys(packages).some(name => id === name || id.startsWith(name + '/'))
  const { build } = await import('vite')
  const result = await build({ configFile: false, root, logLevel: 'silent',
    plugins: [{ name: 'proof-forbid-electron', enforce: 'pre', resolveId(id) {
      if (id === 'electron' || id.startsWith('electron/')) throw new Error('PROOF_ELECTRON_IMPORT')
      return null
    } }],
    build: { ssr: join(root, 'src/service/agent-backend-proof-entry.ts'), target: 'node22', write: false, minify: false,
      rollupOptions: { external, output: { format: 'es', inlineDynamicImports: true,
        paths: id => { if (isBuiltin(id)) return id; const file = exports.get(id); if (!file) throw new Error('PROOF_SDK_EXPORT_UNAVAILABLE'); return file } } } }, ssr: { noExternal: true } })
  const chunks = Array.isArray(result) ? result.flatMap(item => item.output) : result.output
  if (chunks.length !== 1 || chunks[0].type !== 'chunk') throw new Error('PROOF_UNEXPECTED_BUNDLE')
  const directory = join(root, 'node_modules/.cache/21x-agent-backend-proof')
  await mkdir(directory, { recursive: true })
  const entry = join(directory, 'proof.mjs'); await writeFile(entry, chunks[0].code)
  return { entry, node: await realpath(join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node')), nodeVersion: pins.nodeVersion }
}

async function main(args) {
  if (!args.length || args.join(' ') === '--detect') {
    console.log(JSON.stringify({ liveSessionsRun: false, detectionOnly: true, backends: await detectBackends() }, null, 2)); return
  }
  if (args.join(' ') === '--prepare') { await prepareBackendProof(); console.log(JSON.stringify({ prepared: true, liveSessionsRun: false })); return }
  const flags = new Map()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!['--live', '--backend', '--model', '--profile-root'].includes(key) || flags.has(key)) throw new Error('PROOF_INVALID_OPTIONS')
    flags.set(key, key === '--live' ? true : args[++i])
  }
  const backend = flags.get('--backend'), model = flags.get('--model'), selectedRoot = flags.get('--profile-root')
  if (!flags.get('--live') || !Object.hasOwn(names, backend) || typeof model !== 'string' || !/^[A-Za-z0-9._:/\[\]=,-]{1,256}$/.test(model) || typeof selectedRoot !== 'string') throw new Error('PROOF_INVALID_OPTIONS')
  const profileRoot = await realpath(selectedRoot)
  if (dirname(profileRoot) !== await realpath(tmpdir()) || !/^21x-agent-proof-[A-Za-z0-9_-]+$/.test(profileRoot.slice(dirname(profileRoot).length + 1))) throw new Error('PROOF_REQUIRES_EXPLICIT_SYNTHETIC_PROFILE')
  const installed = await detectBackends(), selected = installed.find(row => row.backend === backend)
  if (!selected?.installed) throw new Error('PROOF_CLI_UNAVAILABLE')
  const profile = (await detectBackends({ home: profileRoot, path: '' })).find(row => row.backend === backend)
  if (backend !== 'cursor' && profile.auth !== 'oauth-present-unverified') throw new Error('PROOF_SUBSCRIPTION_METADATA_REQUIRED')
  if (['pi', 'opencode'].includes(backend) && !profile.oauthProviders.includes(model.split('/')[0])) throw new Error('PROOF_MODEL_REQUIRES_MATCHING_OAUTH_PROVIDER')
  await validateProofProfile(profileRoot, backend)
  const staged = await prepareBackendProof()
  const env = proofEnvironment(profileRoot, [dirname(selected.executable)], staged.node)
  if (backend === 'cursor') {
    // Documented read-only auth status; never login, refresh, or fall back to an API key.
    const status = await promisify(execFile)(selected.executable, ['status'], { env, timeout: 5000, maxBuffer: 65536 })
    if (!/authenticated|logged in/i.test(status.stdout) || /not authenticated|not logged|api.?key/i.test(status.stdout)) throw new Error('PROOF_CURSOR_SUBSCRIPTION_REQUIRED')
  }
  const source = 'const {runLiveBackendProof}=await import(process.argv[1]); const r=await runLiveBackendProof(...process.argv.slice(2)); console.log(JSON.stringify(r)); process.exitCode=r.passed?0:1'
  const child = spawn(staged.node, ['--input-type=module', '--eval', source, pathToFileURL(staged.entry).href, backend, model, profileRoot], { env, stdio: ['ignore', 'pipe', 'ignore'] })
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM')
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
  let output = '', overflow = false
  child.stdout.on('data', bytes => { if (output.length + bytes.length > 65536) { overflow = true; child.kill('SIGTERM') } else output += bytes })
  let code
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }) }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
  if (overflow) throw new Error('PROOF_OUTPUT_BOUND_EXCEEDED')
  const report = JSON.parse(output)
  console.log(JSON.stringify({ backend, model, nodeVersion: staged.nodeVersion, liveSessionsRun: true, scope: 'adapter-account-proof', ...report }, null, 2))
  process.exitCode = code === 0 && report.passed ? 0 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)) }
  catch (error) {
    const code = /^PROOF_[A-Z_]+$/.test(error.message) ? error.message : 'PROOF_FAILED'
    console.log(JSON.stringify({ passed: false, code })); process.exitCode = 1
  }
}
