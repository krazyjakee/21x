/**
 * Generated OpenCode runtime plugins (tillDone todo enforcement and secret
 * injection) and the support files they read at runtime.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SessionConfig } from './coding-agent-adapter'
import { buildShellExports } from './shared/shell-exports'

interface TillDoneConfig {
  defaultEnabled: boolean
  sessions: Record<string, boolean>
}

interface RuntimePluginFiles {
  /** Plugin files to register with the OpenCode server */
  pluginFilePaths: string[]
  /** Support files the plugins read dynamically */
  runtimeSupportFilePaths: string[]
  tillDoneConfigPath: string | null
}

function readTillDoneConfigFile(configPath: string | null): TillDoneConfig {
  if (!configPath || !existsSync(configPath)) {
    return { defaultEnabled: true, sessions: {} }
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8') || '{}') as {
      defaultEnabled?: unknown
      enabled?: unknown
      sessions?: unknown
    }
    const sessions = parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
      ? Object.fromEntries(
        Object.entries(parsed.sessions as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'boolean')
      ) as Record<string, boolean>
      : {}

    return {
      defaultEnabled: parsed.defaultEnabled !== undefined
        ? parsed.defaultEnabled !== false
        : parsed.enabled !== false,
      sessions
    }
  } catch {
    return { defaultEnabled: true, sessions: {} }
  }
}

/** Records whether tillDone applies to a session (undefined removes the entry). */
export function setTillDoneSession(configPath: string | null, sessionId: string, enabled: boolean | undefined): void {
  if (!configPath) return
  const config = readTillDoneConfigFile(configPath)
  const sessions = { ...config.sessions }
  if (enabled === undefined) {
    if (!(sessionId in sessions)) return
    delete sessions[sessionId]
  } else {
    sessions[sessionId] = enabled
  }
  writeFileSync(configPath, JSON.stringify({ ...config, sessions }), 'utf-8')
}

/**
 * Writes all runtime plugin files for a session. Must run BEFORE the server
 * starts so the plugins are discovered at startup; plugins read their support
 * files dynamically, so later updates apply without a restart.
 */
export function writeRuntimePluginFiles(config: SessionConfig): RuntimePluginFiles {
  const files: RuntimePluginFiles = { pluginFilePaths: [], runtimeSupportFilePaths: [], tillDoneConfigPath: null }
  if (!config.workspaceDir) return files

  const openCodeDir = join(config.workspaceDir, '.opencode')
  // Do not put generated plugins in `.opencode/plugins`. OpenCode 1.16+
  // can hang while it auto-discovers project-local plugins (upstream issue
  // #30904), and it can install another copy of plugin dependencies in each
  // workspace. These files are registered explicitly through the `plugin` key
  // of `.opencode/opencode.json` (see writeWorkspaceOpencodeConfig).
  const pluginsDir = join(openCodeDir, '.20x-plugins')
  mkdirSync(openCodeDir, { recursive: true })

  // Remove files created by older 20x versions so a retry can recover an
  // already-stuck workspace. Leave user-owned plugins in the directory.
  for (const fileName of ['20x-tilldone.js', '20x-secret-injector.js']) {
    for (const path of [join(openCodeDir, 'plugins', fileName), join(pluginsDir, fileName)]) {
      if (existsSync(path)) unlinkSync(path)
    }
  }

  if (config.tillDone !== false) {
    mkdirSync(pluginsDir, { recursive: true })
    const statePath = join(openCodeDir, '.20x-tilldone-state.json')
    if (!existsSync(statePath)) {
      writeFileSync(statePath, '{}\n', 'utf-8')
    }
    const configPath = join(openCodeDir, '.20x-tilldone-config.json')
    const existingConfig = readTillDoneConfigFile(configPath)
    writeFileSync(configPath, JSON.stringify({ defaultEnabled: true, sessions: existingConfig.sessions }), 'utf-8')
    const pluginPath = join(pluginsDir, '20x-tilldone.js')
    writeFileSync(pluginPath, buildTillDonePluginCode(statePath, configPath), 'utf-8')

    files.runtimeSupportFilePaths.push(statePath, configPath)
    files.tillDoneConfigPath = configPath
    files.pluginFilePaths.push(pluginPath)
    console.log(`[OpencodeAdapter] Wrote tilldone plugin: plugin=${pluginPath}, state=${statePath}`)
  }

  if (config.secretEnvVars && Object.keys(config.secretEnvVars).length > 0) {
    mkdirSync(pluginsDir, { recursive: true })
    // The plugin re-reads the exports file on every bash call, so secret
    // updates take effect immediately.
    const secretsPath = join(openCodeDir, '.20x-secrets')
    writeFileSync(secretsPath, buildShellExports(config.secretEnvVars), 'utf-8')
    const pluginPath = join(pluginsDir, '20x-secret-injector.js')
    writeFileSync(pluginPath, buildSecretInjectorPluginCode(secretsPath), 'utf-8')

    files.runtimeSupportFilePaths.push(secretsPath)
    files.pluginFilePaths.push(pluginPath)
    console.log(`[OpencodeAdapter] Wrote secret files: plugin=${pluginPath}, secrets=${secretsPath} (${Object.keys(config.secretEnvVars).length} secret(s))`)
  }

  writeWorkspaceOpencodeConfig(openCodeDir, config, files)
  return files
}

/**
 * Declares the plugins and the MCP servers of a session in
 * `<workspaceDir>/.opencode/opencode.json`.
 *
 * This file is the only place where an MCP server survives a restart of the
 * OpenCode instance, and that is the point of writing it.
 *
 * OpenCode keeps one instance per directory. Every MCP server added at runtime
 * with `mcp.add` lives in the memory of that instance and nowhere else. When the
 * instance is disposed and re-created — which OpenCode does whenever the config
 * of the directory is patched, and also on its own — the new instance builds its
 * MCP registry from the config files alone, so every runtime-added server is
 * gone. The session keeps running with a tool list that no longer holds
 * `task-management_*`, and the next tool call fails with "Model tried to call
 * unavailable tool". Nothing is logged: the instance finalizer clears its client
 * table before closing the clients, so the "MCP connection closed" warning is
 * skipped, and the HTTP keep-alive socket to the task API stays established.
 *
 * Declaring the servers here makes the re-created instance rebuild them.
 */
function writeWorkspaceOpencodeConfig(openCodeDir: string, config: SessionConfig, files: RuntimePluginFiles): void {
  const configPath = join(openCodeDir, 'opencode.json')

  const mcp: Record<string, unknown> = {}
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    mcp[name] = server.type === 'http' || server.type === 'sse'
      ? { type: 'remote', url: server.url ?? '', ...(server.headers && { headers: server.headers }), enabled: true }
      : {
          type: 'local',
          command: [server.command ?? '', ...(server.args ?? [])],
          ...(server.env && { environment: server.env }),
          enabled: true
        }
  }

  // Nothing to declare and no file from an earlier session to update: leave the
  // workspace untouched.
  if (files.pluginFilePaths.length === 0 && Object.keys(mcp).length === 0 && !existsSync(configPath)) {
    return
  }

  const body: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    plugin: [...files.pluginFilePaths]
  }
  if (Object.keys(mcp).length > 0) body.mcp = mcp

  const serialized = JSON.stringify(body, null, 2)

  try {
    // Rewriting the file makes OpenCode re-create the instance of this directory,
    // which is exactly the event that drops the MCP tools of a running session. So
    // write only when the content really changed — a resume with the same servers
    // must not disturb a session that is already working.
    // MCP headers, stdio environments and the task API token in the
    // task-management URL are credentials, so the file is owner-only. `mode`
    // applies only when the file is created, hence the explicit chmod.
    if (existsSync(configPath) && readFileSync(configPath, 'utf-8') === serialized) {
      chmodSync(configPath, 0o600)
      files.runtimeSupportFilePaths.push(configPath)
      return
    }

    writeFileSync(configPath, serialized, { encoding: 'utf-8', mode: 0o600 })
    chmodSync(configPath, 0o600)
    files.runtimeSupportFilePaths.push(configPath)
    console.log(
      `[OpencodeAdapter] Wrote ${configPath}: ${files.pluginFilePaths.length} plugin(s), ` +
      `MCP servers [${Object.keys(mcp).join(', ') || 'none'}]`
    )
  } catch (err) {
    console.error(
      `[OpencodeAdapter] Failed to write ${configPath} — MCP servers will NOT survive an ` +
      `OpenCode instance restart and may disappear mid-session:`,
      err instanceof Error ? err.message : err
    )
  }
}

export function removeRuntimePluginFiles(files: RuntimePluginFiles): void {
  for (const filePath of [...files.pluginFilePaths, ...files.runtimeSupportFilePaths]) {
    try {
      if (filePath && existsSync(filePath)) {
        rmSync(filePath)
        console.log(`[OpencodeAdapter] Removed runtime plugin file: ${filePath}`)
      }
    } catch (err) {
      console.warn(`[OpencodeAdapter] Failed to remove runtime plugin file: ${err}`)
    }
  }
}

function buildSecretInjectorPluginCode(secretsPath: string): string {
  return [
    '// Auto-generated by 20x — do not edit. Removed on session destroy.',
    'import { readFileSync } from "fs";',
    '',
    'var SECRETS_PATH = ' + JSON.stringify(secretsPath) + ';',
    '',
    'export var SecretInjector = async function() {',
    '  return {',
    '    "tool.execute.before": async function(input, output) {',
    '      if (input.tool === "bash") {',
    '        try {',
    '          var exports = readFileSync(SECRETS_PATH, "utf-8").trim();',
    '          if (exports) output.args.command = exports + "\\n" + output.args.command;',
    '        } catch(e) {}',
    '      }',
    '    }',
    '  };',
    '};',
    ''
  ].join('\n')
}

function buildTillDonePluginCode(statePath: string, configPath: string): string {
  const initialTodoPrompt = 'TillDone: before using other tools, call the built-in todowrite tool to create a concise task list for this task. Keep the list current as you work.'

  return [
    '// Auto-generated by 20x — do not edit. Removed on session destroy.',
    'import { readFileSync, writeFileSync } from "fs";',
    '',
    'var STATE_PATH = ' + JSON.stringify(statePath) + ';',
    'var CONFIG_PATH = ' + JSON.stringify(configPath) + ';',
    'var INITIAL_TODO_PROMPT = ' + JSON.stringify(initialTodoPrompt) + ';',
    '',
    'function isTillDoneEnabled(sessionId) {',
    '  if (!sessionId) return false;',
    '  try {',
    '    var raw = readFileSync(CONFIG_PATH, "utf-8");',
    '    var parsed = JSON.parse(raw || "{}");',
    '    if (parsed?.sessions && typeof parsed.sessions === "object") {',
    '      if (Object.prototype.hasOwnProperty.call(parsed.sessions, sessionId)) {',
    '        return parsed.sessions[sessionId] !== false;',
    '      }',
    '      return false;',
    '    }',
    '    if (Object.prototype.hasOwnProperty.call(parsed || {}, "defaultEnabled")) {',
    '      return parsed.defaultEnabled !== false;',
    '    }',
    '    return parsed?.enabled !== false;',
    '  } catch (e) {',
    '    return false;',
    '  }',
    '}',
    '',
    'function readState() {',
    '  try {',
    '    var raw = readFileSync(STATE_PATH, "utf-8");',
    '    var parsed = JSON.parse(raw || "{}");',
    '    return parsed && typeof parsed === "object" ? parsed : {};',
    '  } catch (e) {',
    '    return {};',
    '  }',
    '}',
    '',
    'function writeState(state) {',
    '  try {',
    '    writeFileSync(STATE_PATH, JSON.stringify(state), "utf-8");',
    '  } catch (e) {}',
    '  return state;',
    '}',
    '',
    '// SDK types: tool.execute.before input has { tool, sessionID, callID }',
    '// SDK types: event hook input has { event: { type, properties: { sessionID, ... } } }',
    '',
    'function normalizeTodos(rawTodos) {',
    '  if (!Array.isArray(rawTodos)) return [];',
    '  return rawTodos.filter(Boolean).map(function(todo, index) {',
    '    return {',
    '      id: todo.id || String(index),',
    '      content: todo.content || todo.text || todo.title || "",',
    '      status: todo.status || "pending"',
    '    };',
    '  });',
    '}',
    '',
    'export var TillDone = async function({ client }) {',
    '  return {',
    '    "tool.execute.before": async function(input) {',
    '      if (input.tool === "todowrite" || input.tool === "skill" || input.tool === "task") return;',
    '      var sessionId = input.sessionID;',
    '      if (!sessionId) return;',
    '      if (!isTillDoneEnabled(sessionId)) return;',
    '      var state = readState();',
    '      var todos = normalizeTodos((state[sessionId] || {}).todos);',
    '      if (todos.length === 0) {',
    '        throw new Error(INITIAL_TODO_PROMPT);',
    '      }',
    '    },',
    '    event: async function(input) {',
    '      var ev = input.event;',
    '      if (!ev) return;',
    '      var sessionId = ev.properties?.sessionID;',
    '      if (!sessionId) return;',
    '      if (!isTillDoneEnabled(sessionId)) return;',
    '      var state = readState();',
    '      var sessionState = state[sessionId] || { todos: [] };',
    '',
    '      if (ev.type === "todo.updated") {',
    '        sessionState.todos = normalizeTodos(ev.properties?.todos || []);',
    '        state[sessionId] = sessionState;',
    '        writeState(state);',
    '        return;',
    '      }',
    '',
    '      if (ev.type === "session.deleted") {',
    '        delete state[sessionId];',
    '        writeState(state);',
    '        return;',
    '      }',
    '    }',
    '  };',
    '};',
    ''
  ].join('\n')
}
