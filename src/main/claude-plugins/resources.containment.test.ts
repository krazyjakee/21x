import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPortableDbFixture } from '../../../test/helpers/portable-db-test-helper'
import { applyPluginResources } from './resources'

let root: string, fixture: ReturnType<typeof createPortableDbFixture>
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plugin-resources-')); fixture = createPortableDbFixture() })
afterEach(() => { vi.restoreAllMocks(); fixture.rawDb.close(); rmSync(root, { recursive: true, force: true }) })
function setup(manifest = {}) {
  const source = fixture.db.createMarketplaceSource({ name: 'fixture', source_url: 'fixture' })
  const plugin = fixture.db.createInstalledPlugin({ name: 'plugin', marketplace_id: source.id, manifest: { name: 'plugin', ...manifest } })
  const dir = join(root, 'plugin'); mkdirSync(join(dir, 'skills'), { recursive: true }); writeFileSync(join(dir, 'skills', 'valid.md'), 'A real skill')
  return { plugin, dir }
}

describe('plugin resource preflight', () => {
  it('refuses a linked MCP directory before creating skills and preserves unrelated resources and files', () => {
    const { plugin, dir } = setup()
    const original = fixture.db.createSkill({ name: 'unrelated', description: 'preserve', content: 'preserve', tags: [] })
    if (!original) throw new Error('Expected the unrelated fixture skill to be created')
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'SKILL.md'), 'private fixture')
    symlinkSync(outside, join(dir, 'skills', 'linked'), 'junction')
    expect(() => applyPluginResources(fixture.db, plugin, dir)).toThrow('containment')
    expect(fixture.db.getSkills().map(skill => skill.id)).toEqual([original.id])
    expect(fixture.db.getMcpServers()).toEqual([])
    expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toBe('private fixture')
  })

  it('materializes only the validated snapshot when resource creation swaps a later directory for a link', () => {
    const { plugin, dir } = setup()
    const commands = join(dir, 'commands'), outside = join(root, 'outside')
    mkdirSync(commands); writeFileSync(join(commands, 'build.md'), 'Validated command')
    mkdirSync(outside); writeFileSync(join(outside, 'build.md'), 'Outside secret')
    const create = fixture.db.createSkill.bind(fixture.db)
    vi.spyOn(fixture.db, 'createSkill').mockImplementationOnce(data => {
      rmSync(commands, { recursive: true }); symlinkSync(outside, commands, 'junction')
      return create(data)
    })
    applyPluginResources(fixture.db, plugin, dir)
    expect(fixture.db.getSkills().find(skill => skill.name === 'plugin:cmd:build')?.content).toBe('Validated command')
    expect(fixture.db.getSkills().some(skill => skill.content.includes('Outside secret'))).toBe(false)
    expect(readFileSync(join(outside, 'build.md'), 'utf8')).toBe('Outside secret')
  })

  it.each(['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers'])('refuses escaping manifest %s paths before resource mutations', field => {
    const { plugin, dir } = setup({ [field]: '../outside' })
    expect(() => applyPluginResources(fixture.db, plugin, dir)).toThrow('containment')
    expect(fixture.db.getSkills()).toEqual([])
    expect(fixture.db.getMcpServers()).toEqual([])
  })
})
