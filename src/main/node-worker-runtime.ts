import { posix, win32 } from 'node:path'

export type WorkerRuntimeKind = 'electron' | 'standalone'

/** Use the owning Node executable; legacy Electron macOS still needs installed Node. */
export function nodeWorkerRuntime(
  platform: NodeJS.Platform = process.platform,
  executable: string = process.execPath,
  environment: NodeJS.ProcessEnv = process.env,
  kind: WorkerRuntimeKind = process.versions.electron ? 'electron' : 'standalone',
): { execPath: string; env: NodeJS.ProcessEnv } {
  const env = { ...environment }
  if (kind === 'standalone') {
    if (!(platform === 'win32' ? win32 : posix).isAbsolute(executable)) {
      throw new Error('Standalone workers require an absolute owning Node executable')
    }
    // Windows environment names are case-insensitive; copied objects are not.
    for (const name of Object.keys(env)) {
      if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[name]
    }
    return { execPath: executable, env }
  }
  if (platform === 'darwin') {
    delete env.ELECTRON_RUN_AS_NODE
    return { execPath: 'node', env }
  }
  return { execPath: executable, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
}
