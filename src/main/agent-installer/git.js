import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import {
  downloadFile, fail, fetchJson, finish, installerDir, removeQuietly, runInstaller, streamProcess
} from './installer-utils.js'

const execFileAsync = promisify(execFile)

const LINUX_PACKAGE_MANAGERS = [
  { bin: 'apt-get', cmd: ['apt-get', 'install', '-y', 'git'] },
  { bin: 'dnf', cmd: ['dnf', 'install', '-y', 'git'] },
  { bin: 'yum', cmd: ['yum', 'install', '-y', 'git'] },
  { bin: 'pacman', cmd: ['pacman', '-S', '--noconfirm', 'git'] },
  { bin: 'zypper', cmd: ['zypper', 'install', '-y', 'git'] },
  { bin: 'apk', cmd: ['apk', 'add', 'git'] }
]

async function isOnPath(bin) {
  try {
    await execFileAsync('which', [bin], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

/** Latest Git for Windows installer URL, falling back to GitHub's latest-release redirect. */
async function resolveGitUrl() {
  const suffix = process.arch === 'arm64' ? 'arm64.exe' : '64-bit.exe'
  const release = await fetchJson(
    'https://api.github.com/repos/git-for-windows/git/releases/latest',
    { 'User-Agent': '21x-app' }
  )
  const asset = release?.assets?.find(a => a.name?.endsWith(suffix) && !a.name.includes('busybox'))
  return asset?.browser_download_url || 'https://github.com/git-for-windows/git/releases/latest/download/Git-64-bit.exe'
}

/**
 * macOS: trigger the Xcode Command Line Tools install (which includes git).
 * xcode-select --install opens the native GUI dialog and exits immediately;
 * the OS runs the actual install in the background.
 */
async function installGitMac(onProgress) {
  onProgress({ stage: 'starting', output: 'Triggering Xcode Command Line Tools install...\n', percent: 5 })
  onProgress({ stage: 'installing', output: 'A macOS dialog will appear. Click "Install" to install Git via Command Line Tools.\nThis may take several minutes.\n', percent: 20 })

  const { error, code, stderr } = await streamProcess('xcode-select', ['--install'], () => {}, 20)
  if (error) return fail(error.message, onProgress)
  if (code === 0) {
    return finish(onProgress, { success: true, error: null }, 'Install dialog launched. Once you finish installing in the macOS dialog, click "Refresh" here to detect git.\n')
  }
  if (stderr.includes('already installed')) {
    return finish(onProgress, { success: true, error: null }, 'Xcode Command Line Tools already installed.\n')
  }
  return fail(stderr.trim() || `Exit code ${code}`, onProgress, `xcode-select exited with code ${code}: ${stderr.trim()}\n`)
}

/**
 * Linux: install via the system package manager, elevated with pkexec (GUI
 * password prompt) when available, otherwise sudo.
 */
async function installGitLinux(onProgress) {
  let chosen = null
  for (const pm of LINUX_PACKAGE_MANAGERS) {
    if (await isOnPath(pm.bin)) {
      chosen = pm
      break
    }
  }
  if (!chosen) {
    return fail('No supported package manager found (apt/dnf/yum/pacman/zypper/apk). Install git manually.')
  }

  const elevator = await isOnPath('pkexec') ? 'pkexec' : 'sudo'
  onProgress({ stage: 'starting', output: `$ ${elevator} ${chosen.cmd.join(' ')}\n`, percent: 5 })
  onProgress({ stage: 'installing', output: `Detected ${chosen.bin}. ${elevator === 'pkexec' ? 'A GUI prompt will appear for your password.' : 'You may be prompted for your sudo password in the terminal.'}\n`, percent: 20 })

  const { error, code, stderr } = await streamProcess(elevator, chosen.cmd, onProgress, 60)
  if (error) return fail(error.message, onProgress)
  return finish(
    onProgress,
    { success: code === 0, error: code === 0 ? null : `Install failed (code ${code}): ${stderr.trim()}` },
    'Git installed successfully!\n',
    `Process exited with code ${code}\n`
  )
}

export async function installGit(onProgress) {
  if (process.platform === 'darwin') return installGitMac(onProgress)
  if (process.platform === 'linux') return installGitLinux(onProgress)
  if (process.platform !== 'win32') {
    return fail('Automatic Git installation is only supported on Windows, macOS, and Linux. Please install from https://git-scm.com/')
  }

  onProgress({ stage: 'starting', output: 'Downloading Git installer...\n', percent: 5 })
  const exePath = join(installerDir(), 'git-install.exe')

  try {
    const gitUrl = await resolveGitUrl()
    onProgress({ stage: 'installing', output: `Downloading from git-scm.com...\n`, percent: 10 })
    await downloadFile(gitUrl, exePath, onProgress)

    onProgress({ stage: 'installing', output: 'Download complete. Starting installer (you may see a UAC prompt)...\n', percent: 70 })
    const result = await runInstaller(exePath, ['/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS', '/COMPONENTS=icons,ext,ext\\shellhere,ext\\guihere,gitlfs,assoc,assoc_sh'], onProgress)
    removeQuietly(exePath)
    return finish(onProgress, result, 'Git installed successfully!\n')
  } catch (err) {
    removeQuietly(exePath)
    return fail(err.message, onProgress)
  }
}
