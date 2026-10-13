/**
 * Materialises a downloaded plugin's files as 20x resources and removes them again.
 * Resources are linked to their plugin by naming convention: skills are tagged
 * ['plugin', pluginName]; MCP servers and agents are named "<pluginName>:<key>".
 */

import { join, basename, relative } from 'path'
import { readPluginTree, validateManifestPaths, PluginSourceError } from './containment'

import type { DatabaseManager, InstalledPluginRecord } from '../database'

export interface PluginResources {
  skills: { id: string; name: string; description: string }[]
  mcpServers: { id: string; name: string; command: string; args: string[] }[]
  agents: { id: string; name: string; description: string }[]
  commands: string[]
}

export const pluginSkills = (db: DatabaseManager, pluginName: string) =>
  db.getSkills().filter((s) => s.tags.includes('plugin') && s.tags.includes(pluginName))

export const pluginMcpServers = (db: DatabaseManager, pluginName: string) =>
  db.getMcpServers().filter((s) => s.name.startsWith(`${pluginName}:`))

export const pluginAgents = (db: DatabaseManager, pluginName: string) =>
  db.getAgents().filter((a) => a.name.startsWith(`${pluginName}:`))

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/

function frontmatterField(content: string, key: string): string | undefined {
  const match = content.match(FRONTMATTER_RE)?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return match ? match[1].replace(/^["']|["']$/g, '').trim() : undefined
}

/** Frontmatter `description`, else the first non-empty, non-heading line. */
function markdownDescription(content: string): string {
  const fromFrontmatter = frontmatterField(content, 'description')
  if (fromFrontmatter) return fromFrontmatter
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) return trimmed.slice(0, 200)
  }
  return ''
}


function createPluginSkill(
  db: DatabaseManager,
  pluginName: string,
  skillKey: string,
  description: string,
  content: string
): void {
  try {
    db.createSkill({
      name: `${pluginName}:${skillKey}`,
      description: description || `Skill from plugin "${pluginName}"`,
      content,
      tags: ['plugin', pluginName]
    })
  } catch (err) {
    console.warn(`[ClaudePluginManager] Failed to create skill "${skillKey}" from plugin "${pluginName}":`, err)
  }
}

function createPluginMcpServer(
  db: DatabaseManager,
  pluginName: string,
  serverName: string,
  config: {
    command?: string
    args?: string[]
    env?: Record<string, string>
    environment?: Record<string, string>
    url?: string
    type?: 'local' | 'remote'
  }
): void {
  try {
    db.createMcpServer({
      name: `${pluginName}:${serverName}`,
      type: config.type || (config.url ? 'remote' : 'local'),
      command: config.command || '',
      args: config.args || [],
      url: config.url,
      environment: config.env || config.environment || {},
      source: 'plugin'
    })
  } catch (err) {
    console.warn(`[ClaudePluginManager] Failed to create MCP server "${serverName}" from plugin "${pluginName}":`, err)
  }
}

/**
 * Applies plugin resources from downloaded files:
 * - skills/ and commands/ markdown → 20x skills (commands are keyed "cmd:<name>")
 * - .mcp.json (or manifest mcpServers) → 20x MCP servers
 * - agents/*.md → 20x agents, pre-assigned all of the plugin's skills and MCP servers
 */
export function applyPluginResources(db: DatabaseManager, plugin: InstalledPluginRecord, pluginDir: string): void {
  const pluginName = plugin.name
  const manifest = plugin.manifest

  // Validate and read the entire bounded tree before modifying any resources.
  // Historic trees containing links are preserved and require manual reconciliation.
  const contents = new Map([...readPluginTree(pluginDir)].map(([path, content]) => [path, content.toString('utf-8')]))
  const key = (path: string): string => relative(pluginDir, path).replace(/\\/g, '/')
  const exists = (path: string): boolean => contents.has(key(path)) || [...contents.keys()].some(file => file.startsWith(key(path) + '/'))
  const list = (path: string): string[] => {
    const prefix = key(path) + '/'
    return [...new Set([...contents.keys()].filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length).split('/')[0]))]
  }
  const stat = (path: string) => ({ isFile: () => contents.has(key(path)), isDirectory: () => !contents.has(key(path)) && exists(path) })
  const listMdFiles = (path: string): string[] => list(path).filter(file => file.endsWith('.md') && stat(join(path, file)).isFile())
  const readResource = (path: string): string => {
    const content = contents.get(key(path))
    if (content === undefined) throw new PluginSourceError('Plugin resource was not present in the contained tree')
    return content
  }
  validateManifestPaths(manifest as unknown as Record<string, unknown>)
  if (exists(join(pluginDir, '.mcp.json')) && !contents.has('.mcp.json')) {
    throw new PluginSourceError('Plugin MCP resource must be a contained regular file')
  }

  const skillsDir = join(pluginDir, 'skills')
  if (exists(skillsDir)) {
    for (const entry of list(skillsDir)) {
      const entryPath = join(skillsDir, entry)
      const entryStat = stat(entryPath)
      if (entryStat.isDirectory()) {
        // Claude Code format: skills/<skill-name>/SKILL.md; otherwise every .md in the dir
        const skillMdPath = join(entryPath, 'SKILL.md')
        if (stat(skillMdPath).isFile()) {
          const content = readResource(skillMdPath)
          createPluginSkill(db, pluginName, entry, markdownDescription(content), content)
        } else {
          for (const mdFile of listMdFiles(entryPath)) {
            const content = readResource(join(entryPath, mdFile))
            createPluginSkill(db, pluginName, `${entry}/${basename(mdFile, '.md')}`, markdownDescription(content), content)
          }
        }
      } else if (entryStat.isFile() && entry.endsWith('.md')) {
        const content = readResource(entryPath)
        createPluginSkill(db, pluginName, basename(entry, '.md'), markdownDescription(content), content)
      }
    }
  }

  const commandsDir = join(pluginDir, 'commands')
  if (exists(commandsDir)) {
    const createCommand = (key: string, cmdName: string, content: string): void =>
      createPluginSkill(
        db,
        pluginName,
        `cmd:${key}`,
        markdownDescription(content) || `Command "${cmdName}" from plugin "${pluginName}"`,
        content
      )

    for (const entry of list(commandsDir)) {
      const entryPath = join(commandsDir, entry)
      const entryStat = stat(entryPath)
      if (entryStat.isFile() && entry.endsWith('.md')) {
        const cmdName = basename(entry, '.md')
        createCommand(cmdName, cmdName, readResource(entryPath))
      } else if (entryStat.isDirectory()) {
        for (const mdFile of listMdFiles(entryPath)) {
          const cmdName = basename(mdFile, '.md')
          createCommand(`${entry}/${cmdName}`, cmdName, readResource(join(entryPath, mdFile)))
        }
      }
    }
  }

  const mcpJsonPath = join(pluginDir, '.mcp.json')
  if (exists(mcpJsonPath)) {
    try {
      const mcpConfig = JSON.parse(readResource(mcpJsonPath))
      // Standard format is { mcpServers: { name: config } }; some plugins omit the wrapper
      const servers = mcpConfig.mcpServers || mcpConfig
      if (typeof servers === 'object' && !Array.isArray(servers)) {
        for (const [serverName, serverConfig] of Object.entries(servers)) {
          createPluginMcpServer(db, pluginName, serverName, serverConfig as Parameters<typeof createPluginMcpServer>[3])
        }
      }
    } catch (err) {
      console.warn(`[ClaudePluginManager] Failed to parse .mcp.json for plugin "${pluginName}":`, err)
    }
  }

  // Agents inherit only the skills/MCP servers created above, so this must run after them
  const skillIds = pluginSkills(db, pluginName).map((s) => s.id)
  const mcpServerIds = pluginMcpServers(db, pluginName).map((s) => s.id)

  const agentsDir = join(pluginDir, 'agents')
  if (exists(agentsDir)) {
    for (const entry of list(agentsDir)) {
      const entryPath = join(agentsDir, entry)
      if (!stat(entryPath).isFile() || !entry.endsWith('.md')) continue
      const content = readResource(entryPath)
      const agentKey = basename(entry, '.md')
      try {
        db.createAgent({
          name: `${pluginName}:${agentKey}`,
          config: {
            system_prompt: content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim(),
            model: frontmatterField(content, 'model') || undefined,
            skill_ids: skillIds.length ? skillIds : undefined,
            mcp_servers: mcpServerIds.length ? mcpServerIds : undefined
          }
        })
      } catch (err) {
        console.warn(`[ClaudePluginManager] Failed to create agent "${agentKey}" from plugin "${pluginName}":`, err)
      }
    }
  }

  // Fallbacks for plugins that declare resources in the manifest instead of shipping files
  if (!exists(mcpJsonPath) && manifest.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)) {
    const servers = manifest.mcpServers as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
    for (const [serverName, serverConfig] of Object.entries(servers)) {
      try {
        db.createMcpServer({
          name: `${pluginName}:${serverName}`,
          command: serverConfig.command || '',
          args: serverConfig.args || [],
          environment: serverConfig.env || {},
          source: 'plugin'
        })
      } catch (err) {
        console.warn(`[ClaudePluginManager] Failed to create MCP server from manifest:`, err)
      }
    }
  }

  const hasSkillFiles = exists(skillsDir) || exists(commandsDir)
  if (!hasSkillFiles && Array.isArray(manifest.skills)) {
    for (const skillPath of manifest.skills) {
      try {
        db.createSkill({
          name: `${pluginName}:${typeof skillPath === 'string' ? skillPath.replace(/\//g, '-').replace(/^-/, '') : 'skill'}`,
          description: `Skill from plugin "${pluginName}"`,
          content: `Plugin skill: ${skillPath}`,
          tags: ['plugin', pluginName]
        })
      } catch (err) {
        console.warn(`[ClaudePluginManager] Failed to create skill from manifest:`, err)
      }
    }
  }
}

export function removePluginResources(db: DatabaseManager, pluginName: string): void {
  for (const skill of pluginSkills(db, pluginName)) db.deleteSkill(skill.id)
  for (const server of pluginMcpServers(db, pluginName)) db.deleteMcpServer(server.id)
  for (const agent of pluginAgents(db, pluginName)) db.deleteAgent(agent.id)
}
