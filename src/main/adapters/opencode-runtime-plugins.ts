/**
 * Generated OpenCode runtime plugins (tillDone todo enforcement and secret
 * injection) and the support files they read at runtime.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
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
  // workspace. These files are registered explicitly through config.update().
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

  return files
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
