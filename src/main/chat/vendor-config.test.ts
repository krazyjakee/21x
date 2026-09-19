import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readVendorConfig } from './vendor-config'

const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR
const temporaryDirs: string[] = []

function useTemporaryAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), '21x-vendor-config-'))
  temporaryDirs.push(dir)
  process.env.PI_CODING_AGENT_DIR = dir
  return dir
}

afterEach(() => {
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readVendorConfig', () => {
  it('reads local endpoints from Pi current top-level models-store format without an API key', () => {
    const dir = useTemporaryAgentDir()
    writeFileSync(join(dir, 'models-store.json'), JSON.stringify({
      'llama.cpp': {
        models: [{ id: 'qwen3.8-27b', baseUrl: 'http://127.0.0.1:8080/v1' }]
      }
    }))

    expect(readVendorConfig('llama.cpp', 'qwen3.8-27b')).toEqual({
      baseUrl: 'http://127.0.0.1:8080/v1'
    })
  })

  it('continues to read the older nested models-store format', () => {
    const dir = useTemporaryAgentDir()
    writeFileSync(join(dir, 'models-store.json'), JSON.stringify({
      providers: {
        local: { models: [{ id: 'model', baseUrl: 'http://localhost:1234/v1' }] }
      }
    }))

    expect(readVendorConfig('local', 'model').baseUrl).toBe('http://localhost:1234/v1')
  })
})
