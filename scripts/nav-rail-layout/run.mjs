import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, '../..')
const profile = await mkdtemp(resolve(tmpdir(), 'nav-rail-profile-'))
const output = process.env.NAV_RAIL_OUTPUT || await mkdtemp(resolve(tmpdir(), 'nav-rail-results-'))
await mkdir(output, { recursive: true })
const server = await createServer({
  configFile: false,
  root: directory,
  resolve: { alias: { '@': resolve(root, 'src/renderer/src'), '@shared': resolve(root, 'src/shared') } },
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [root] } }
})
try {
  await server.listen()
  const env = { ...process.env, NAV_RAIL_URL: server.resolvedUrls.local[0], NAV_RAIL_PROFILE: profile, NAV_RAIL_OUTPUT: output }
  delete env.ELECTRON_RUN_AS_NODE
  process.exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(electron, [resolve(directory, 'check.cjs')], { env, stdio: 'inherit', timeout: 120_000 })
    child.on('error', reject)
    child.on('exit', code => resolveExit(code ?? 1))
  })
  console.log(`Navigation rail evidence: ${output}`)
} finally {
  await server.close()
  await rm(profile, { recursive: true, force: true })
}
