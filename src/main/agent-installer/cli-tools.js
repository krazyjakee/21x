import { chmodSync, copyFileSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  downloadFile, ensureOnPath, fail, fetchJson, findFile, finish, installerDir, removeQuietly,
  runMacPkgInstaller, runQuiet, spawnInstall, streamProcess
} from './installer-utils.js'

/**
 * Pick the preferred GitHub CLI macOS asset from a release payload.
 * GitHub CLI publishes macOS zip archives consistently; some releases also
 * include pkg installers, so both are supported (zip preferred).
 * @param {{ assets?: Array<{ name?: string, browser_download_url?: string }> }} release
 * @param {string} arch
 * @returns {{ name: string, browser_download_url: string } | null}
 */
export function selectGhMacAsset(release, arch = process.arch) {
  const releaseAssets = release?.assets || []
  const normalizedArch = arch === 'arm64' ? 'arm64' : 'amd64'
  for (const suffix of [`macOS_${normalizedArch}.zip`, `macOS_${normalizedArch}.pkg`]) {
    const asset = releaseAssets.find((entry) => entry?.name?.startsWith('gh_') && entry.name.endsWith(suffix))
    if (asset?.browser_download_url) return asset
  }
  return null
}

/** Pick the RTK archive for the current OS and CPU architecture. */
export function selectRtkAsset(release, platform = process.platform, arch = process.arch) {
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64'
  const suffix = platform === 'darwin'
    ? `rtk-${cpu}-apple-darwin.tar.gz`
    : platform === 'linux'
      ? `rtk-${cpu}-unknown-linux-${arch === 'arm64' ? 'gnu' : 'musl'}.tar.gz`
      : null
  if (!suffix) return null
  return release?.assets?.find((asset) => asset?.name === suffix && asset?.browser_download_url) || null
}

function githubAsset(asset) {
  return asset?.browser_download_url ? { url: asset.browser_download_url, name: asset.name } : null
}

function glabAsset(release, os) {
  const suffix = `_${os}_${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.tar.gz`
  const link = release.assets?.links?.find(l => l.name?.endsWith(suffix) || l.url?.endsWith(suffix))
  return link?.url ? { url: link.url, name: link.name } : null
}

/** Per-tool release sources; each *Asset() returns { url, name } or null. */
const CLI_TOOLS = {
  gh: {
    label: 'GitHub CLI',
    wingetId: 'GitHub.cli',
    host: 'github.com',
    docsUrl: 'https://cli.github.com/',
    unsupported: 'GitHub CLI must be installed manually on this platform. See https://cli.github.com/',
    releaseUrl: 'https://api.github.com/repos/cli/cli/releases/latest',
    headers: { 'User-Agent': '21x-app' },
    macAsset: (release) => githubAsset(selectGhMacAsset(release)),
    linuxAsset: (release) => {
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
      return githubAsset(release.assets?.find(a => a.name?.startsWith('gh_') && a.name.endsWith(`linux_${arch}.tar.gz`)))
    }
  },
  glab: {
    label: 'GitLab CLI',
    wingetId: 'GLab.GLab',
    host: 'gitlab.com',
    docsUrl: 'https://gitlab.com/gitlab-org/cli',
    unsupported: 'GitLab CLI must be installed manually on this platform. See https://gitlab.com/gitlab-org/cli#installation',
    releaseUrl: 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest',
    macAsset: (release) => glabAsset(release, 'macOS'),
    linuxAsset: (release) => glabAsset(release, 'Linux')
  },
  rtk: {
    label: 'RTK',
    wingetId: 'rtk-ai.rtk',
    host: 'github.com',
    docsUrl: 'https://github.com/rtk-ai/rtk',
    unsupported: 'RTK must be installed manually on this platform. See https://github.com/rtk-ai/rtk',
    releaseUrl: 'https://api.github.com/repos/rtk-ai/rtk/releases/latest',
    headers: { 'User-Agent': '21x-app' },
    macAsset: (release) => selectRtkAsset(release, 'darwin'),
    linuxAsset: (release) => selectRtkAsset(release, 'linux')
  }
}

async function resolveAsset(tool, pick) {
  const release = await fetchJson(tool.releaseUrl, tool.headers)
  return release ? tool[pick](release) : null
}

/** Extract `name` from a .zip/.tar.gz and copy it into /usr/local/bin via an admin prompt. */
async function installMacArchive(name, archivePath, extractDir, onProgress) {
  onProgress({ stage: 'installing', output: `Extracting ${name} archive...\n`, percent: 70 })
  mkdirSync(extractDir, { recursive: true })
  if (archivePath.endsWith('.zip')) {
    await runQuiet('unzip', ['-q', archivePath, '-d', extractDir])
  } else {
    await runQuiet('tar', ['-xzf', archivePath, '-C', extractDir])
  }

  const binPath = findFile(extractDir, name)
  if (!binPath) throw new Error(`${name} binary not found in extracted archive`)

  onProgress({ stage: 'installing', output: `Installing ${name} to /usr/local/bin (admin prompt)...\n`, percent: 85 })
  const safeBin = binPath.replace(/"/g, '\\"')
  const script = `do shell script "mkdir -p /usr/local/bin && cp \\"${safeBin}\\" /usr/local/bin/${name} && chmod +x /usr/local/bin/${name}" with administrator privileges`
  const { error, code, stderr } = await streamProcess('osascript', ['-e', script], () => {}, 85)
  if (error) return { success: false, error: error.message }
  if (code === 0) return { success: true, error: null }
  return {
    success: false,
    error: stderr.includes('User canceled') ? 'Installation cancelled' : `Install failed: ${stderr.trim()}`
  }
}

async function installMac(name, tool, onProgress) {
  onProgress({ stage: 'starting', output: `Resolving latest ${name} release...\n`, percent: 5 })
  const downloadDir = installerDir()
  const extractDir = join(downloadDir, `${name}-extracted`)
  let assetPath = null

  try {
    const asset = await resolveAsset(tool, 'macAsset')
    if (!asset) throw new Error(`Could not resolve ${name} download URL. Install manually from ${tool.docsUrl}`)

    const ext = ['.pkg', '.zip'].find((e) => (asset.name || asset.url).endsWith(e)) || '.tar.gz'
    assetPath = join(downloadDir, `${name}-install${ext}`)
    onProgress({ stage: 'installing', output: `Downloading ${name} from ${tool.host}...\n`, percent: 10 })
    await downloadFile(asset.url, assetPath, onProgress)

    const result = ext === '.pkg'
      ? await runMacPkgInstaller(assetPath, onProgress)
      : await installMacArchive(name, assetPath, extractDir, onProgress)
    removeQuietly(assetPath, extractDir)
    return finish(onProgress, result, `${tool.label} installed successfully!\n`)
  } catch (err) {
    removeQuietly(assetPath, extractDir)
    return fail(err.message, onProgress)
  }
}

/** Download a release tarball and place `name` in ~/.local/bin (no sudo). */
async function installLinux(name, tool, onProgress) {
  onProgress({ stage: 'starting', output: `Resolving latest ${name} release...\n`, percent: 5 })
  const asset = await resolveAsset(tool, 'linuxAsset')
  if (!asset) {
    return fail(`Could not resolve ${name} download URL. Install manually from ${tool.docsUrl}`, onProgress, `Could not resolve ${name} download URL.\n`)
  }

  const binDir = join(homedir(), '.local', 'bin')
  const downloadDir = installerDir()
  const tarPath = join(downloadDir, `${name}.tar.gz`)
  const extractDir = join(downloadDir, `${name}-extracted`)

  try {
    onProgress({ stage: 'installing', output: `Downloading ${name}...\n`, percent: 10 })
    await downloadFile(asset.url, tarPath, onProgress)

    onProgress({ stage: 'installing', output: 'Extracting tarball...\n', percent: 70 })
    mkdirSync(extractDir, { recursive: true })
    await runQuiet('tar', ['-xzf', tarPath, '-C', extractDir])
    const binPath = findFile(extractDir, name)
    if (!binPath) throw new Error(`${name} binary not found in extracted archive`)

    onProgress({ stage: 'installing', output: `Installing to ${binDir}/${name}...\n`, percent: 90 })
    mkdirSync(binDir, { recursive: true })
    const dest = join(binDir, name)
    try { unlinkSync(dest) } catch { /* ignore if missing */ }
    copyFileSync(binPath, dest)
    chmodSync(dest, 0o755)
    removeQuietly(tarPath, extractDir)

    // Lets later spawn() calls in this session find the new binary.
    const pathHint = ensureOnPath(binDir)
      ? `\nNOTE: ${binDir} is not on your shell PATH. Add to ~/.bashrc or ~/.zshrc:\n  export PATH="$HOME/.local/bin:$PATH"\n`
      : ''
    return finish(onProgress, { success: true, error: null }, `${name} installed successfully!${pathHint}`)
  } catch (err) {
    removeQuietly(tarPath, extractDir)
    return fail(err.message, onProgress)
  }
}

/**
 * Install the GitHub (gh), GitLab (glab), or RTK CLI: winget on Windows, release
 * download elsewhere.
 * @param {'gh' | 'glab' | 'rtk'} name
 */
export async function installCliTool(name, onProgress) {
  const tool = CLI_TOOLS[name]
  if (process.platform === 'win32') {
    return spawnInstall('winget', ['install', '--id', tool.wingetId, '-e', '--accept-source-agreements', '--accept-package-agreements'], onProgress)
  }
  if (process.platform === 'darwin') return installMac(name, tool, onProgress)
  if (process.platform === 'linux') return installLinux(name, tool, onProgress)
  return fail(tool.unsupported)
}
