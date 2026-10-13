const PASSTHROUGH_ENV = [
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'LANG',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'
] as const

/** Connector workers receive HTTP/runtime necessities, never agent keys or preloads. */
export function pieceWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of PASSTHROUGH_ENV) {
    const value = source[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}
