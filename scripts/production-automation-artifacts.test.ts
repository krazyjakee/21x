import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertNoProductionAutomation } from './production-automation-artifacts.mjs'

describe('production artifact diagnostic detection', () => {
  it('accepts normal retained desktop dispatch and refuses diagnostic frontend and fixture dispatch controls', () => {
    expect(() => assertNoProductionAutomation('await invoke("desktop_invoke", {operation:"project:getAll"})')).not.toThrow()
    for (const body of ['window.__TWENTYONEX_DATABASE_SMOKE__=async()=>{}', 'invoke("engine_invoke", {})', 'if(enabled) request("engine.fixture.crash")', 'request("engine.probe")']) {
      expect(() => assertNoProductionAutomation(body)).toThrow('Diagnostic automation found')
    }
  })

  it('keeps the reviewed native production entry point separate from diagnostic and embedded automation entry points', () => {
    const main = readFileSync('src-tauri/src/main.rs', 'utf8')
    const host = readFileSync('src-tauri/src/production_host.rs', 'utf8')
    const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8')
    const handlers = [...host.matchAll(/\.invoke_handler\(tauri::generate_handler!\[([^\]]+)\]\)/g)]
    expect(handlers).toHaveLength(1)
    expect(handlers[0][1].split(',').map(name => name.trim()).filter(Boolean).sort()).toEqual(['desktop_invoke', 'engine_status'])
    expect(main).toMatch(/#\[cfg\(all\(feature = "production-service", feature = "synthetic-desktop"\)\)\]\s*compile_error!\(/)
    expect(main).toMatch(/#\[cfg\(feature = "production-service"\)\]\s*fn main\(\)\s*\{\s*production_host::run\(\);\s*\}/)
    expect(cargo).not.toMatch(/tauri-plugin-(?:wdio|webdriver)|wdio-webdriver/)
    // This policy test protects reviewed source wiring. The separate actual
    // peer/artifact controls establish their own runtime/build scope.
  })
})
