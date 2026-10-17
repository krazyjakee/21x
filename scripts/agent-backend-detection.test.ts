import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { detectBackends, proofEnvironment, validateProofProfile } from './agent-backend-proof.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('noninteractive account detection and future live proof environment', () => {
  it('only reads bounded metadata and never calls an installed CLI or exposes credentials', async () => {
    const home = mkdtempSync(join(tmpdir(), '21x-agent-detection-')); roots.push(home)
    const bin = join(home, '.local/bin'); mkdirSync(bin, { recursive: true })
    const marker = join(home, 'must-not-exist')
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 })
    const file = join(home, '.codex/auth.json'); mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-private-token' } }))
    const report = await detectBackends({ home, path: bin })
    expect(report.find(row => row.backend === 'codex')).toMatchObject({ installed: true, auth: 'oauth-present-unverified' })
    expect(JSON.stringify(report)).not.toContain('synthetic-private-token')
    const { existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(false)
  })
  it('keeps account and app environment out of the staged child', () => {
    const env = proofEnvironment('/tmp/21x-agent-proof-synthetic', ['/synthetic/bin'], '/staged/node/node')
    expect(env.PATH).toContain('/staged/node')
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'TAURI_PROFILE_ROOT']) expect(env).not.toHaveProperty(name)
    expect(env.HOME).toBe('/tmp/21x-agent-proof-synthetic')
  })
  it('refuses inline billing keys and settings overrides before a future account run', async () => {
    const root = mkdtempSync(join(tmpdir(), '21x-agent-proof-test-')); roots.push(root)
    mkdirSync(join(root, '.codex'))
    const file = join(root, '.codex/auth.json')
    writeFileSync(file, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic' }, OPENAI_API_KEY: null }))
    await validateProofProfile(root, 'codex')
    writeFileSync(file, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'synthetic-disallowed-key' }))
    await expect(validateProofProfile(root, 'codex')).rejects.toThrow('PROOF_REQUIRES_FRESH_KEY_FREE_PROFILE')
    writeFileSync(file, '{}'); writeFileSync(join(root, '.codex/config.json'), '{}')
    await expect(validateProofProfile(root, 'codex')).rejects.toThrow('PROOF_REQUIRES_FRESH_KEY_FREE_PROFILE')
  })
})
