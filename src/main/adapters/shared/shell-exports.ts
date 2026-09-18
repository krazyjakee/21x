/**
 * Renders env vars as POSIX `export KEY='value'` lines. Values are single-quoted
 * with embedded quotes escaped as '\'' so secrets are never shell-interpreted.
 */
export function buildShellExports(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `export ${key}='${value.replace(/'/g, "'\\''")}'`)
    .join('\n')
}
