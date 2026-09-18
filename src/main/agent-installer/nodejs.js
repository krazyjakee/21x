import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  downloadFile, ensureOnPath, fail, fetchJson, finish, installerDir, removeQuietly,
  runInstaller, runMacPkgInstaller, runQuiet
} from './installer-utils.js'

// Used when nodejs.org/dist/index.json cannot be fetched.
const FALLBACK_NODE_VERSION = 'v22.20.0'

/**
 * Build the expected Node.js archive name for a platform/arch/version tuple.
 * macOS publishes a universal .pkg without an arch suffix.
 */
export function getNodejsAssetName(platform, arch, version) {
  const normalizedArch = arch === 'arm64' ? 'arm64' : 'x64'
  if (platform === 'darwin') return `node-${version}.pkg`
  if (platform === 'linux') return `node-${version}-linux-${normalizedArch}.tar.xz`
  return `node-${version}-${normalizedArch}.msi`
}

/** Resolve the latest Node.js LTS download for this platform. */
async function resolveNodejsRelease() {
  const releases = await fetchJson('https://nodejs.org/dist/index.json')
  const version = (Array.isArray(releases) && releases.find((r) => r.lts)?.version) || FALLBACK_NODE_VERSION
  const url = `https://nodejs.org/dist/${version}/${getNodejsAssetName(process.platform, process.arch, version)}`
  return { url, version }
}

/**
 * Extract the tarball to ~/.local/share/20x/node and symlink node/npm/npx
 * into ~/.local/bin, so no sudo is required.
 */
async function installNodejsLinux(onProgress) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const home = homedir()
  const installRoot = join(home, '.local', 'share', '20x', 'node')
  const binDir = join(home, '.local', 'bin')
  const tarPath = join(installerDir(), 'nodejs-install.tar.xz')

  try {
    onProgress({ stage: 'starting', output: 'Resolving latest Node.js LTS...\n', percent: 5 })
    const { url, version } = await resolveNodejsRelease()

    onProgress({ stage: 'installing', output: `Downloading from nodejs.org...\n`, percent: 10 })
    await downloadFile(url, tarPath, onProgress)

    onProgress({ stage: 'installing', output: 'Extracting tarball...\n', percent: 70 })
    mkdirSync(installRoot, { recursive: true })
    const extractedPath = join(installRoot, `node-${version}-linux-${arch}`) // the archive's top-level dir
    removeQuietly(extractedPath)
    await runQuiet('tar', ['-xJf', tarPath, '-C', installRoot])
    if (!existsSync(extractedPath)) {
      throw new Error(`Extracted folder not found at ${extractedPath}`)
    }

    onProgress({ stage: 'installing', output: 'Symlinking node/npm/npx into ~/.local/bin...\n', percent: 90 })
    mkdirSync(binDir, { recursive: true })
    for (const binary of ['node', 'npm', 'npx']) {
      const link = join(binDir, binary)
      try { unlinkSync(link) } catch { /* ignore if missing */ }
      symlinkSync(join(extractedPath, 'bin', binary), link)
    }
    removeQuietly(tarPath)

    // Lets later npm-based installs in this session find npm without a
    // restart. If PATH lacked binDir, the user's shell rc probably does too.
    const pathWasMissing = ensureOnPath(binDir)
    const output = pathWasMissing
      ? `Node.js ${version} installed.\nNOTE: ${binDir} is not on your shell PATH. Add this to ~/.bashrc or ~/.zshrc:\n  export PATH="$HOME/.local/bin:$PATH"\nThen reopen your terminal. (21x has injected it for this session so subsequent installs will work.)\n`
      : `Node.js ${version} installed successfully!\n`
    return finish(onProgress, { success: true, error: null }, output)
  } catch (err) {
    removeQuietly(tarPath)
    return fail(err.message, onProgress)
  }
}

/**
 * Install Node.js: .msi on Windows, .pkg on macOS, tarball into ~/.local on Linux.
 */
export async function installNodejs(onProgress) {
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'

  if (process.platform === 'linux') return installNodejsLinux(onProgress)
  if (!isWin && !isMac) {
    return fail('Automatic Node.js installation is only supported on Windows, macOS, and Linux. Please install from https://nodejs.org/')
  }

  onProgress({ stage: 'starting', output: 'Downloading Node.js installer...\n', percent: 5 })
  const installerPath = join(installerDir(), `nodejs-install.${isMac ? 'pkg' : 'msi'}`)

  try {
    const { url } = await resolveNodejsRelease()
    onProgress({ stage: 'installing', output: `Downloading from nodejs.org...\n`, percent: 10 })
    await downloadFile(url, installerPath, onProgress)

    let result
    if (isMac) {
      onProgress({ stage: 'installing', output: 'Download complete. Starting installer (you may see an admin prompt)...\n', percent: 70 })
      result = await runMacPkgInstaller(installerPath, onProgress)
    } else {
      onProgress({ stage: 'installing', output: 'Download complete. Starting installer (you may see a UAC prompt)...\n', percent: 70 })
      result = await runInstaller('msiexec.exe', ['/i', installerPath, '/qn', '/norestart', 'ADDLOCAL=ALL'], onProgress)
    }
    removeQuietly(installerPath)
    return finish(onProgress, result, 'Node.js installed successfully! npm is included.\n')
  } catch (err) {
    removeQuietly(installerPath)
    return fail(err.message, onProgress)
  }
}
