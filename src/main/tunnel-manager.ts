import { bin as developmentBinary } from 'cloudflared'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { app } from 'electron'
import { TunnelManagerCore } from './tunnel-manager-core'

// Electron alone resolves its bundled binary. Portable hosts must provide their
// own staged binary and private profile through TunnelManagerCore.
let owner: TunnelManagerCore | null = null
function tunnelOwner(): TunnelManagerCore {
  if (owner) return owner
  const binary = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'cloudflared', 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
    : developmentBinary
  const privateRoot = join(app.getPath('userData'), 'mobile-tunnels')
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 })
  owner = new TunnelManagerCore({ binary, privateRoot, environment: { ...process.env }, spawn })
  return owner
}
export function startTunnel(port: number): Promise<string> { return tunnelOwner().start(port) }
export function stopTunnel(): void { if (owner) void owner.stop().catch(() => {}) }
/** Actual child close, for shutdown owners; the legacy intent API stays intact. */
export function stopTunnelAcknowledged(): Promise<void> { return owner?.stop() ?? Promise.resolve() }
export function getTunnelUrl(): string | null { return owner?.url ?? null }
export function isTunnelActive(): boolean { return owner?.active ?? false }
