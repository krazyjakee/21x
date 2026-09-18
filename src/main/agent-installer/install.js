import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'
import { detectInstalledAgents, getPiCommandCandidates } from './detect.js'
import { fail, spawnInstall, streamProcess } from './installer-utils.js'
import { installNodejs } from './nodejs.js'
import { installGit } from './git.js'
import { installCliTool } from './cli-tools.js'

const execFileAsync = promisify(execFile)

/**
 * npm install commands for the npm-installed agents.
 * @type {Record<string, { cmd: string, args: string[] }>}
 */
const INSTALL_COMMANDS = {
  claudeCode: { cmd: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
  opencode: { cmd: 'npm', args: ['install', '-g', 'opencode-ai'] },
  codex: { cmd: 'npm', args: ['install', '-g', '@openai/codex'] },
  pi: { cmd: 'npm', args: ['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent'] },
  pnpm: { cmd: 'npm', args: ['install', '-g', 'pnpm'] }
}

/** Coding agents installed with their vendor's standalone installer (no npm needed). */
const STANDALONE_AGENTS = {
  opencode: {
    curlUrl: 'https://opencode.ai/install',
    curlShell: 'bash',
    winPowershell: [
      '$installDir = "$env:USERPROFILE\\.opencode\\bin"',
      'New-Item -ItemType Directory -Force -Path $installDir | Out-Null',
      '$zip = "$env:TEMP\\opencode-windows-x64.zip"',
      'Invoke-WebRequest -Uri "https://github.com/anomalyco/opencode/releases/latest/download/opencode-windows-x64.zip" -OutFile $zip',
      'Expand-Archive -Force -Path $zip -DestinationPath $installDir',
      'Remove-Item $zip -Force',
      '$userPath = [Environment]::GetEnvironmentVariable("Path", "User")',
      'if ($userPath -notlike "*$installDir*") { [Environment]::SetEnvironmentVariable("Path", "$installDir;$userPath", "User") }',
      'Write-Host "OpenCode installed to $installDir"'
    ].join('; '),
    successMsg: 'OpenCode installed successfully!\n'
  },
  claudeCode: {
    curlUrl: 'https://claude.ai/install.sh',
    curlShell: 'sh',
    winPowershell: 'irm https://claude.ai/install.ps1 | iex',
    successMsg: 'Claude Code installed successfully!\n'
  },
  codex: {
    curlUrl: 'https://chatgpt.com/codex/install.sh',
    curlShell: 'sh',
    winPowershell: 'irm https://chatgpt.com/codex/install.ps1 | iex',
    successMsg: 'Codex installed successfully!\n'
  }
}

/**
 * Run the vendor installer: a PowerShell one-liner on Windows, the official
 * curl | sh script elsewhere.
 */
async function installStandaloneAgent(agentName, opts, onProgress) {
  const isWin = process.platform === 'win32'
  const curlCmd = `curl -fsSL ${opts.curlUrl} | ${opts.curlShell}`
  onProgress({ stage: 'starting', output: isWin ? `$ powershell -c "${opts.winPowershell}"\n` : `$ ${curlCmd}\n`, percent: 5 })

  const { error, code } = isWin
    ? await streamProcess('powershell', ['-ExecutionPolicy', 'ByPass', '-Command', opts.winPowershell], onProgress, 50, { windowsHide: true })
    : await streamProcess('bash', ['-c', curlCmd], onProgress, 50)
  if (error) return fail(error.message, onProgress)

  // detectInstalledAgents() puts the installers' target dirs (~/.opencode/bin,
  // ~/.local/bin) on PATH, so a non-zero exit with the agent now present
  // still counts as success.
  const newStatus = await detectInstalledAgents()
  if (code === 0 || newStatus[agentName]?.installed) {
    onProgress({ stage: 'complete', output: opts.successMsg, percent: 100 })
    return { success: true, error: null, newStatus }
  }
  onProgress({ stage: 'error', output: `${isWin ? 'Installer' : 'Install script'} exited with code ${code}\n`, percent: 100 })
  return { success: false, error: `Install failed with exit code ${code}`, newStatus }
}

async function installPi(onProgress) {
  const isWin = process.platform === 'win32'
  const piResult = await spawnInstall(
    isWin ? 'npm.cmd' : 'npm',
    ['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent'],
    (progress) => onProgress({ ...progress, percent: Math.min(70, Math.round(progress.percent * 0.7)) })
  )
  if (!piResult.success) return piResult

  const piStatus = await detectInstalledAgents()
  if (!piStatus.pi?.installed) {
    const error = 'Pi was installed, but the Pi executable could not be found.'
    return fail(error, onProgress, `${error}\n`)
  }

  const piCandidates = await getPiCommandCandidates()
  const piCommand = piCandidates.find((candidate) => existsSync(candidate)) || (isWin ? 'pi.cmd' : 'pi')
  return spawnInstall(
    piCommand,
    ['install', 'npm:pi-mcp-adapter'],
    (progress) => onProgress({ ...progress, percent: Math.min(100, 70 + Math.round(progress.percent * 0.3)) })
  )
}

/**
 * Install an agent CLI tool.
 * @param {string} agentName - One of 'claudeCode', 'opencode', 'codex', 'pi', 'pnpm', 'gh', 'glab', 'nodejs', 'npm', 'git'
 * @param {(progress: { stage: string, output: string, percent: number }) => void} onProgress
 * @returns {Promise<{ success: boolean, error: string | null, newStatus: object }>}
 */
export async function installAgent(agentName, onProgress) {
  const isWin = process.platform === 'win32'

  if (agentName === 'nodejs') return installNodejs(onProgress)
  if (agentName === 'git') return installGit(onProgress)
  if (agentName === 'npm') {
    onProgress({ stage: 'starting', output: 'npm is bundled with Node.js. Installing Node.js...\n', percent: 0 })
    return installNodejs(onProgress)
  }
  if (agentName === 'gh' || agentName === 'glab') return installCliTool(agentName, onProgress)
  if (Object.hasOwn(STANDALONE_AGENTS, agentName)) return installStandaloneAgent(agentName, STANDALONE_AGENTS[agentName], onProgress)
  if (agentName === 'pi') return installPi(onProgress)

  const info = INSTALL_COMMANDS[agentName]
  if (!info) return fail(`Unknown agent: ${agentName}`)

  try {
    await execFileAsync(isWin ? 'npm.cmd' : 'npm', ['--version'], { timeout: 5000, shell: isWin, windowsHide: true })
  } catch {
    return fail('npm is not installed. Install Node.js first.', onProgress, 'npm is not installed. Please install Node.js first (it includes npm).\n')
  }

  return spawnInstall(isWin ? `${info.cmd}.cmd` : info.cmd, info.args, onProgress)
}
