/**
 * Materialises a downloaded plugin's files as 20x resources and removes them again.
 * Resources are linked to their plugin by naming convention: skills are tagged
 * ['plugin', pluginName]; MCP servers and agents are named "<pluginName>:<key>".
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'

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

const listMdFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.md'))

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

  const skillsDir = join(pluginDir, 'skills')
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir)) {
      const entryPath = join(skillsDir, entry)
      const stat = statSync(entryPath)
      if (stat.isDirectory()) {
        // Claude Code format: skills/<skill-name>/SKILL.md; otherwise every .md in the dir
        const skillMdPath = join(entryPath, 'SKILL.md')
        if (existsSync(skillMdPath)) {
          const content = readFileSync(skillMdPath, 'utf-8')
          createPluginSkill(db, pluginName, entry, markdownDescription(content), content)
        } else {
          for (const mdFile of listMdFiles(entryPath)) {
            const content = readFileSync(join(entryPath, mdFile), 'utf-8')
            createPluginSkill(db, pluginName, `${entry}/${basename(mdFile, '.md')}`, markdownDescription(content), content)
          }
        }
      } else if (stat.isFile() && entry.endsWith('.md')) {
        const content = readFileSync(entryPath, 'utf-8')
        createPluginSkill(db, pluginName, basename(entry, '.md'), markdownDescription(content), content)
      }
    }
  }

  const commandsDir = join(pluginDir, 'commands')
  if (existsSync(commandsDir)) {
    const createCommand = (key: string, cmdName: string, content: string): void =>
      createPluginSkill(
        db,
        pluginName,
        `cmd:${key}`,
        markdownDescription(content) || `Command "${cmdName}" from plugin "${pluginName}"`,
        content
      )

    for (const entry of readdirSync(commandsDir)) {
      const entryPath = join(commandsDir, entry)
      const stat = statSync(entryPath)
      if (stat.isFile() && entry.endsWith('.md')) {
        const cmdName = basename(entry, '.md')
        createCommand(cmdName, cmdName, readFileSync(entryPath, 'utf-8'))
      } else if (stat.isDirectory()) {
        for (const mdFile of listMdFiles(entryPath)) {
          const cmdName = basename(mdFile, '.md')
          createCommand(`${entry}/${cmdName}`, cmdName, readFileSync(join(entryPath, mdFile), 'utf-8'))
        }
      }
    }
  }

  const mcpJsonPath = join(pluginDir, '.mcp.json')
  if (existsSync(mcpJsonPath)) {
    try {
      const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
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
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir)) {
      const entryPath = join(agentsDir, entry)
      if (!statSync(entryPath).isFile() || !entry.endsWith('.md')) continue
      const content = readFileSync(entryPath, 'utf-8')
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
  if (!existsSync(mcpJsonPath) && manifest.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)) {
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

  const hasSkillFiles = existsSync(skillsDir) || existsSync(commandsDir)
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
