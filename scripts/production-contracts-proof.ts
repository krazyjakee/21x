import { UI_DESKTOP_CODECS } from '../src/shared/ui-desktop-codecs'
import { TRAY_PREFERENCE_CODECS } from '../src/shared/tray-preference-codecs'
import { CLI_MCP_CODECS } from '../src/shared/cli-mcp-codecs'
import { TASK_ATTACHMENT_CODECS } from '../src/shared/task-attachment-codecs'
import { HEARTBEAT_CODECS } from '../src/shared/heartbeat-codecs'
import { WORKTREE_RUNTIME_CODECS } from '../src/shared/worktree-runtime-codecs'
import { TASK_GROUP_CODECS } from '../src/shared/task-group-codecs'
import { PROJECT_RUNTIME_CODECS } from '../src/shared/project-runtime-codecs'
import { PROJECT_CONFIGURATION_CODECS } from '../src/shared/project-configuration-codecs'
import { VOICE_MANAGEMENT_CODECS } from '../src/shared/voice-management-codecs'
import { GIT_PROVIDER_CODECS } from '../src/shared/git-provider-codecs'
import { WORKSPACE_FILE_CODECS } from '../src/shared/workspace-file-codecs'
import { AGENT_INSTALLER_CODECS } from '../src/shared/agent-installer-codecs'
import { ARTIFACT_CODECS } from '../src/shared/artifact-codecs'
/** Pure codec corpus: no service/SDK imports, profiles, mutations or credentials. */
import { writeFile } from 'node:fs/promises'
import { DATABASE_COMMAND_CODECS } from '../src/shared/database-desktop-codecs'
import { CONFIGURATION_COMMAND_CODECS, CONFIGURATION_CONTENT_OPERATIONS } from '../src/shared/configuration-desktop-codecs'
import { AGENT_CONFIGURATION_CODECS } from '../src/shared/agent-configuration-codecs'
import { TASK_LIFECYCLE_CODECS } from '../src/shared/task-lifecycle-codecs'
import { PRODUCTION_AGENT_CODECS } from '../src/shared/production-agent-codecs'
import { COMMANDER_COMMAND_CODECS } from '../src/shared/commander-desktop-codecs'
import { PRODUCTION_SETTINGS_CODECS, PRODUCTION_SETTINGS_KEYS, PRODUCTION_ENV_KEYS } from '../src/shared/production-settings-codecs'
import { TERMINAL_COMMAND_CODECS } from '../src/shared/terminal-desktop-codecs'
import { MCP_CODECS } from '../src/shared/mcp-codecs'
import { TASK_SOURCE_CODECS } from '../src/shared/task-source-codecs'
import { CONNECTOR_CODECS } from '../src/shared/connector-codecs'
import { TASK_SOURCE_PLUGIN_CODECS } from '../src/shared/task-source-plugin-codecs'
import { SESSION_CONTEXT_CODECS } from '../src/shared/session-context-codecs'
import { CLAUDE_PLUGIN_CODECS } from '../src/shared/claude-plugin-codecs'
import { MOBILE_CODECS } from '../src/shared/mobile-codecs'
import type { JsonValue } from '../src/shared/service-protocol'

// Preserve the production binding's override order; older diagnostic task,
// settings and agent CRUD schemas must not supply these proof payloads.
export const PROOF_COMMAND_CODECS = { ...DATABASE_COMMAND_CODECS, ...TRAY_PREFERENCE_CODECS,
  ...Object.fromEntries(CONFIGURATION_CONTENT_OPERATIONS.map(name => [name, CONFIGURATION_COMMAND_CODECS[name]])),
  ...PROJECT_CONFIGURATION_CODECS, ...AGENT_CONFIGURATION_CODECS, ...TASK_LIFECYCLE_CODECS, ...PRODUCTION_AGENT_CODECS, ...COMMANDER_COMMAND_CODECS,
  ...PRODUCTION_SETTINGS_CODECS, ...TERMINAL_COMMAND_CODECS, ...MCP_CODECS, ...TASK_SOURCE_CODECS, ...CONNECTOR_CODECS, ...TASK_SOURCE_PLUGIN_CODECS, ...SESSION_CONTEXT_CODECS, ...CLAUDE_PLUGIN_CODECS, ...MOBILE_CODECS, ...AGENT_INSTALLER_CODECS, ...ARTIFACT_CODECS, ...VOICE_MANAGEMENT_CODECS, ...GIT_PROVIDER_CODECS, ...WORKSPACE_FILE_CODECS, ...TASK_GROUP_CODECS, ...PROJECT_RUNTIME_CODECS, ...HEARTBEAT_CODECS, ...WORKTREE_RUNTIME_CODECS, ...CLI_MCP_CODECS, ...TASK_ATTACHMENT_CODECS, ...UI_DESKTOP_CODECS }
const task = 'task_fixture', project = 'project_fixture', agent = 'agent_fixture', session = 'session_fixture'
const image = { name: 'fixture.png', mimeType: 'image/png', data: 'iVBORw0KGgoAAAAA' }
const policy = { mode: 'observe', contextRatio: 0.6, compactions: 3, wakeups: 20, turns: 10, maxAgeDays: 7 }
let deepOutput: JsonValue = 'fixture leaf'
for (let depth = 0; depth < 40; depth++) deepOutput = { child: deepOutput }
const largeConfig = { coding_agent: 'pi', mcp_servers: Array.from({ length: 30 }, (_, server) => ({ serverId: `server_${server}`, enabledTools: Array.from({ length: 120 }, (_, tool) => `tool_${tool}_` + 'x'.repeat(240)) })) }

/** One explicit valid API argument tuple for every finite production command. */
export const PRODUCTION_REQUEST_ARGUMENTS: Record<string, unknown[]> = {
  'app:getMinimizeToTray': [], 'app:setMinimizeToTray': [true],
  'ui:publishState': [{ view: 'commander', projectId: project, modal: null, selectedTaskId: null, selectedTaskTitle: null, dashboardPreviewTaskId: null, captainOpen: false, settingsTab: null, waitingForYou: false, visibleTaskIds: [], canvas: { viewport: { x: 0, y: 0, zoom: 1 }, panels: [] } }],
  'cliMcp:snapshot': [], 'cliMcp:upsert': [{ name: 'fixture', targets: ['codex'], definition: { transport: 'stdio', command: 'fixture-mcp', args: [], env: {} } }],
  'cliMcp:remove': [{ cli: 'codex', name: 'fixture', expectedFingerprint: 'a'.repeat(64) }], 'cliMcp:setEnabled': [{ cli: 'codex', name: 'fixture', expectedFingerprint: 'a'.repeat(64), enabled: true }],
  'cliMcp:setToolEnabled': [{ cli: 'codex', name: 'fixture', expectedFingerprint: 'a'.repeat(64), tool: 'fixture_tool', enabled: true }], 'cliMcp:probe': [{ cli: 'codex', name: 'fixture', expectedFingerprint: 'a'.repeat(64) }],
  'attachments:save': [task, '/tmp/selected-fixture.txt'],
  'attachments:open': [task, '12345678-1234-4234-9234-123456789abc'],
  'attachments:download': [task, '12345678-1234-4234-9234-123456789abc'],
  'chatImages:saveToTask': [task, [image]], 'attachments:remove': [task, '00000000-0000-4000-8000-000000000001'],
  'heartbeat:enable': [task, 30], 'heartbeat:disable': [task], 'heartbeat:runNow': [task], 'heartbeat:getLogs': [task, 20], 'heartbeat:getStatus': [task], 'heartbeat:updateInterval': [task, 60], 'heartbeat:readFile': [task], 'heartbeat:writeFile': [task, '# Local heartbeat\nCheck the task status.'],
  'worktree:setup': [task, [{ fullName: 'fixture/repo', defaultBranch: 'main' }], 'fixture', 'github'], 'worktree:changes': [task, [{ fullName: 'fixture/repo' }]], 'worktree:files': [task, [{ fullName: 'fixture/repo' }]], 'worktree:readFile': [task, 'fixture/repo', 'README.md'], 'worktree:cleanup': [task, [{ fullName: 'fixture/repo' }], 'fixture', true], 'workspace:runCleanupNow': [],
  'taskGroups:list': [project, true], 'taskGroups:get': ['group_fixture'], 'taskGroups:history': [task],
  'taskGroups:create': [{ title: 'Fixture batch', task_ids: [task, 'task_second'], agent_id: agent }],
  'taskGroups:add': ['group_fixture', ['task_third']], 'taskGroups:remove': ['group_fixture', task], 'taskGroups:dissolve': ['group_fixture'],
  'taskGroups:move': ['group_fixture', 'ready_for_review'], 'taskGroups:review': [{ group_id: 'group_fixture', action: 'approve', task_ids: [task], complete_at_source: false }],
  'project:getStatus': [project], 'project:getAllStatuses': [], 'project:getStatusHistory': [project, { limit: 5, cursor: null }], 'project:getCaptainMemory': [project],
  'projectLimits:getState': [project], 'projectLimits:isAllPaused': [], 'projectLimits:pauseAll': [true],
  'concurrency:getState': [project], 'concurrency:setCaptainControl': [project, true], 'concurrency:pin': [project, agent, 2],
  'tasks:getWorkspaceDir': [task], 'shell:readTextFile': ['/trusted-workspace/task_fixture/report.md'], 'shell:openPath': ['/trusted-workspace/task_fixture'], 'shell:showItemInFolder': ['/trusted-workspace/task_fixture/report.md'],
  'github:checkCli': [], 'github:fetchOrgs': [], 'github:fetchOrgRepos': ['fixture-org'], 'github:fetchUserRepos': [], 'github:fetchPullRequestDetails': ['https://github.com/fixture/repo/pull/42'],
  'gitlab:checkCli': [], 'gitlab:fetchOrgs': [], 'gitlab:fetchOrgRepos': ['team/subgroup'], 'gitlab:fetchUserRepos': [],
  'forgejo:checkCli': [], 'forgejo:setLogin': ['fixture account'], 'forgejo:fetchOrgs': [], 'forgejo:fetchOrgRepos': ['fixture-org'], 'forgejo:fetchUserRepos': [],
  'git:recordRepoProviders': [['fixture/repo'], 'github'],
  'voice:getSnapshot': [], 'voice:setEnabled': [false], 'voice:getRuntime': [], 'voice:installRuntime': [], 'voice:removeRuntime': [],
  'voice:installModel': ['nemo-parakeet-tdt-0.6b-v3'], 'voice:removeModel': ['sherpa-streaming-zipformer-en'], 'voice:removeAllModels': [], 'voice:selectModel': ['nemo-fast-conformer-en-480ms'], 'voice:setEndpointSilence': [1.5],
  'voice:tts:getSnapshot': [], 'voice:tts:setEnabled': [false], 'voice:tts:setEngine': ['local'], 'voice:tts:setVoice': ['local:kitten-nano-en-v0_2:0'], 'voice:tts:setSpeed': [1.25], 'voice:tts:setMaxChars': [1200], 'voice:tts:setSpeakActionResults': [false], 'voice:tts:setOnlyVoiceTurns': [true],
  'voice:tts:installModel': ['kitten-nano-en-v0_2'], 'voice:tts:selectModel': ['kokoro-en-v0_19'], 'voice:tts:removeModel': ['kitten-nano-en-v0_2'],
  'agent-installer:detect': [], 'agent-installer:install': ['opencode'], 'artifacts:scan': [task], 'artifacts:copyFile': [task, 'report.md'], 'artifacts:read': [task, 'artifacts/fixture/report.md'],
  'db:getTasks': [project], 'db:getTask': [task], 'db:createTask': [{ title: 'Fixture task', project_id: project }],
  'db:updateTask': [task, { title: 'Updated fixture', status: 'ready_for_review' }], 'db:deleteTask': [task],
  'db:getSubtasks': [task], 'db:reorderSubtasks': [task, ['subtask_one', 'subtask_two']], 'project:moveTask': [task, project],
  'tasks:getCoordinatorTaskId': [project], 'plugin:executeAction': ['fixture_action', task, 'source_fixture', 'Fixture input'],
  'project:getAll': [{ includeArchived: true }], 'project:get': [project], 'project:getDefault': [], 'project:create': [{ name: 'Fixture project', description: 'Codec proof' }],
  'settings:get': ['theme'], 'settings:set': ['theme', 'dark'], 'settings:getAll': [],
  'agentSession:getTranscriptSnapshot': [task, 0], 'agentSession:getTranscriptDelta': [task, 0],
  'agentSession:getTranscriptPage': [task, { version: 1, mode: 'snapshot', after: 0 }],
  'skills:getAll': [], 'skills:create': [{ name: 'Fixture skill', description: 'Description', content: 'Instructions' }],
  'skills:update': ['skill_fixture', { content: 'Updated instructions', expected_version: 1 }], 'skills:delete': ['skill_fixture'], 'skills:setProject': ['skill_fixture', project],
  'project:update': [project, { name: 'Updated project', git_provider: 'github', git_org: 'fixture-org' }],
  'project:archive': [project, false], 'project:reorder': [[project]],
  'projectRepo:list': [project], 'projectRepo:add': [project, { name: 'fixture/repo', provider: 'github', org: 'fixture', default_branch: 'main' }],
  'projectRepo:update': ['repo_fixture', { default_branch: null }], 'projectRepo:remove': ['repo_fixture'], 'projectRepo:reorder': [project, ['repo_fixture']],
  'projectResource:list': [project], 'projectResource:add': [project, { label: 'Fixture notes', url: null, notes: 'Context' }],
  'projectResource:update': ['resource_fixture', { label: 'Updated notes' }], 'projectResource:remove': ['resource_fixture'], 'projectResource:reorder': [project, ['resource_fixture']],
  'agent:getAll': [], 'agent:create': [{ name: 'Fixture agent', server_url: 'http://localhost:4096', config: { coding_agent: 'pi', model: 'fixture', max_parallel_sessions: 2 } }],
  'agent:update': [agent, { config: { coding_agent: 'codex', permission_mode: 'ask', sandbox_mode: 'workspace-write' } }], 'agent:delete': [agent],
  'agentConfig:getProviders': ['http://localhost:4096', 'opencode'], 'agentConfig:listModels': ['pi'],
  'agentSession:start': [agent, task, undefined, true], 'agentSession:startTask': [task], 'agentSession:resume': [agent, task, session],
  'agentSession:send': [session, 'Fixture continuation', task, agent, [], 'delivery_fixture_one'],
  'agentSession:sendByTaskId': [task, 'Fixture continuation', [], 'delivery_fixture_two'],
  'agentSession:abort': [session], 'agentSession:stop': [session], 'agentSession:stopByTaskId': [task], 'agentSession:switchAgent': [task, 'agent_other'],
  'agentSession:approve': [session, false, 'Fixture answer', 'question', 'native/request:fixture'],
  'agent:getStartQueue': [], 'agent:getStartRecoveryState': [task], 'agentSession:getRawTranscript': [task],
  'captainRuntime:get': [project], 'captainRuntime:switch': [project, agent], 'captainRuntime:retry': [project], 'captainRuntime:rollback': [project],
  'commander:listSessions': [{ search: 'Fixture', includeArchived: true }], 'commander:createSession': [{ title: 'Fixture Commander' }],
  'commander:renameSession': [session, 'Renamed fixture'], 'commander:archiveSession': [session, false], 'commander:listMessages': [session],
  'commander:markRead': [session], 'commander:setActiveSession': [null], 'commander:send': [session, 'Describe fixture', [image]],
  'commander:getImage': ['image_fixture'], 'commander:cancel': [session], 'commander:undoAction': [session, 'action:fixture'], 'commander:getActivity': [session],
  'chat:start': [{ messages: [{ role: 'user', content: 'Describe fixture', images: [image] }], system: 'Fixture context', maxToolCalls: 0 }], 'chat:cancel': ['turn_fixture'],
  'secrets:getAll': [], 'secrets:create': [{ name: 'Fixture metadata', description: 'Not a live credential', env_var_name: 'FIXTURE_PROOF_VALUE', value: 'synthetic-fixture-value' }],
  'secrets:update': ['secret_fixture', { description: 'Updated fixture metadata' }], 'secrets:delete': ['secret_fixture'], 'env:get': ['OPENAI_API_KEY'],
  'terminal:create': ['terminal:fixture', 80, 24, '/trusted-fixture/workspace'], 'terminal:write': ['terminal:fixture', '\u001b[31m\u0000'],
  'terminal:resize': ['terminal:fixture', 120, 32], 'terminal:kill': ['terminal:fixture', 42], 'terminal:getCwd': ['terminal:fixture', 42], 'terminal:getBuffer': ['terminal:fixture', 500],
  'mcp:getAll': [], 'mcp:create': [{ name: 'Fixture MCP', type: 'local', command: 'fixture-mcp', args: ['--fixture'], headers: { Authorization: 'synthetic-fixture-value' }, environment: { FIXTURE_VALUE: 'synthetic-fixture-value' } }],
  'mcp:update': ['mcp.fixture:one', { name: 'Updated fixture MCP', type: 'remote', url: 'https://mcp.example.test/api' }],
  'mcp:delete': ['mcp.fixture:one'], 'mcp:testConnection': [{ id: 'mcp.fixture:one', name: 'Fixture MCP', type: 'remote', url: 'https://mcp.example.test/api' }],
  'mcp:startOAuthFlow': ['mcp.fixture:one'], 'mcp:getOAuthStatus': ['mcp.fixture:one'], 'mcp:revokeOAuthToken': ['mcp.fixture:one'],
  'mcp:probeForAuth': ['https://mcp.example.test/api'], 'mcp:submitManualClientId': ['mcp.fixture:one', 'fixture-client-id'],
  'taskSource:getAll': [project], 'taskSource:create': [{ name: 'Fixture issues', plugin_id: 'github-issues', mcp_server_id: null, project_id: project, config: { owner: 'fixture', repo: 'codec-proof', state: 'open', labels: 'proof' } }],
  'taskSource:update': ['source_fixture', { name: 'Updated fixture source', enabled: false }], 'taskSource:delete': ['source_fixture'],
  'taskSource:sync': ['source_fixture'], 'taskSource:exportUpdate': [task, { title: 'Fixture title', description: 'Multiline\nfixture context', status: 'ready_for_review', priority: 'urgent', assignee: 'Fixture User', due_date: null, labels: ['proof'], complete_at_source: false }],
  'taskSource:getUsers': ['source_fixture'], 'taskSource:reassign': [task, ['external:user-one', 'external:user-two'], 'Fixture Users'],
  'connectors:bridgePieces': [], 'connectors:ensureInstance': ['@activepieces/piece-trello', 'connector.fixture:one'],
  'connectors:credentialStatus': ['connector.fixture:one'], 'connectors:setCredentials': ['connector.fixture:one', { username: 'fixture-user', password: 'synthetic-fixture-password' }, 'session'],
  'connectors:clearCredentials': ['connector.fixture:one'], 'connectors:oauthConnect': ['connector.fixture:one', { clientId: 'fixture-client', clientSecret: 'synthetic-fixture-secret' }, 'persistent'],
  'connectors:syncStatus': ['connector.fixture:one'],
  'plugin:list': [], 'plugin:getDocumentation': ['notion'],
  'plugin:resolveOptions': ['notion', 'status_options', { data_source_id: 'external:database', api_token: '__21x_api_key_set__' }, 'server_fixture', 'source_fixture'],
  'sessionContext:getSnapshot': [{ kind: 'captain', ownerId: project }], 'sessionContext:setPolicy': [policy],
  'claudePlugin:getMarketplaceSources': [], 'claudePlugin:addMarketplaceSource': [{ name: 'Fixture marketplace', source_type: 'github', source_url: 'fixture/marketplace#main', auto_update: false }],
  'claudePlugin:removeMarketplaceSource': ['marketplace.fixture:one'], 'claudePlugin:fetchCatalog': ['marketplace.fixture:one'], 'claudePlugin:discoverPlugins': ['fixture'],
  'claudePlugin:getInstalledPlugins': [], 'claudePlugin:installPlugin': ['fixture-plugin', 'marketplace.fixture:one', 'user'],
  'claudePlugin:uninstallPlugin': ['plugin.fixture:one'], 'claudePlugin:enablePlugin': ['plugin.fixture:one'], 'claudePlugin:disablePlugin': ['plugin.fixture:one'], 'claudePlugin:getPluginResources': ['plugin.fixture:one'],
  'mobile:getInfo': [], 'mobile:setAccess': [{ enabled: false, lanAccess: false, sessionIdleDays: 7 }], 'mobile:startTunnel': [], 'mobile:stopTunnel': [],
  'mobile:setCustomUrl': ['https://mobile.example.test/access'], 'mobile:clearCustomUrl': [], 'mobile:getPendingPin': [], 'mobile:getSessions': [],
  'mobile:revokeSession': ['mobile-session-fixture'], 'mobile:revokeAllSessions': []
}

type Variant = { operation: string; case: string; args: unknown[] }
function boundedPng(byteLength: number, name = 'fixture.png') {
  const bytes = Buffer.alloc(byteLength)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return { name, mimeType: 'image/png', data: bytes.toString('base64') }
}
const cliBoundaryArgs = Array.from({ length: 128 }, (_, i) => i === 127 ? '🌱'.repeat(2048) : `argument_${i}`)
const cliBoundaryEnvironment = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`FIXTURE_${i}`, i === 127 ? '🌱'.repeat(8192) : '${FIXTURE_SOURCE}']))
const cliBoundaryHeaders = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`X-Fixture-${i}`, i === 127 ? '🌱'.repeat(8192) : 'fixture']))
export const PRODUCTION_REQUEST_VARIANTS: Variant[] = [
  { operation: 'project:create', case: 'full-project-editor', args: [{ name: 'Project🌱', description: 'Full editor', default_agent_id: agent, captain_agent_id: null, git_provider: 'forgejo', git_org: 'synthetic', settings: { limits: { max_concurrent_agents: 2, daily_session_cap: 10, daily_token_cap: null, paused: false }, captain_wakeups: { enabled: false, kinds: ['approval_pending'] }, scheduled_review: { enabled: true, cron: '0 9 * * 1-5' }, concurrency: { captain_control: true, levels: { [agent]: 2 }, pinned: { [agent]: 1 } }, note: 'Kept' } }] },
  { operation: 'project:update', case: 'full-project-editor-update', args: [project, { default_agent_id: null, captain_agent_id: agent, settings: { limits: { paused: true }, captain_wakeups: { enabled: false }, scheduled_review: { enabled: false, cron: '0 9 * * 1-5' } } }] },
  { operation: 'project:create', case: 'project-editor-ecma-nonwhitespace-name', args: [{ name: '\u0085', settings: { scheduled_review: { enabled: false, cron: '\uFEFF0\uFEFF9 * * 1-5\uFEFF' } } }] },
  { operation: 'app:setMinimizeToTray', case: 'tray-disabled-preference', args: [false] },
  { operation: 'ui:publishState', case: 'ui-full-finite-state', args: [{ view: 'canvas', projectId: project, modal: 'edit', selectedTaskId: task, selectedTaskTitle: 'Local🌱state', dashboardPreviewTaskId: task, captainOpen: true, settingsTab: 'voice', waitingForYou: true, visibleTaskIds: [task], canvas: { viewport: { x: -10000000, y: 10000000, zoom: 3 }, panels: [{ panelId: 'panel:fixture', type: 'task', taskId: task, title: 'Local🌱panel', x: 10000000, y: -10000000, width: 1000000, height: 1 }] } }] },

  { operation: 'cliMcp:upsert', case: 'cli-ecma-nonwhitespace-name-command', args: [{ name: '\u0085', targets: ['claude-code'], definition: { transport: 'stdio', command: '\u0085' } }] },
  { operation: 'cliMcp:upsert', case: 'cli-utf16-args-env-boundaries', args: [{ name: '🌱'.repeat(64), previousName: 'previous', targets: ['claude-code', 'opencode', 'codex'], expectedFingerprints: { 'claude-code': 'a'.repeat(64), opencode: 'b'.repeat(64), codex: 'c'.repeat(64) }, definition: { transport: 'stdio', command: '🌱'.repeat(2048), args: cliBoundaryArgs, env: cliBoundaryEnvironment } }] },
  { operation: 'cliMcp:upsert', case: 'cli-http-url-header-boundaries', args: [{ name: 'fixture', targets: ['opencode'], definition: { transport: 'http', url: 'https://fixture.example/' + 'x'.repeat(4096 - 'https://fixture.example/'.length), headers: cliBoundaryHeaders } }] },
  { operation: 'cliMcp:upsert', case: 'cli-sse-empty-records', args: [{ name: 'fixture', targets: ['claude-code'], definition: { transport: 'sse', url: 'https://fixture.example/mcp', env: {}, headers: {} } }] },
  { operation: 'cliMcp:setToolEnabled', case: 'cli-utf16-tool-boundary', args: [{ cli: 'opencode', name: '🌱'.repeat(64), tool: '🌱'.repeat(64), expectedFingerprint: 'a'.repeat(64), enabled: false }] },
  { operation: 'chatImages:saveToTask', case: 'attachment-single-512k-plain-base64', args: [task, [boundedPng(512 * 1024)]] },
  { operation: 'chatImages:saveToTask', case: 'attachment-five-total-512k', args: [task, [104857, 104857, 104857, 104857, 104860].map((size, i) => boundedPng(size, `fixture-${i}.png`))] },
  { operation: 'chatImages:saveToTask', case: 'attachment-raw-name-sanitization', args: [task, ['../unsafe\0.png', 'CON.png', 'folder\\fixture.png', 'report\u202E.png', ''].map(name => ({ ...image, name }))] },
  { operation: 'chatImages:saveToTask', case: 'attachment-empty-images', args: [task, []] },
  { operation: 'attachments:save', case: 'selection-save-windows-display-path', args: [task, 'C:\\Users\\Fixture\\selected.txt'] },
  { operation: 'attachments:save', case: 'selection-save-path-byte-boundary', args: ['t'.repeat(128), '/' + 'a'.repeat(4095)] },
  { operation: 'attachments:open', case: 'attachment-open-uppercase-version-five-uuid', args: ['t'.repeat(128), 'ABCDEFAB-CDEF-5ABC-ABCD-ABCDEFABCDEF'] },
  { operation: 'artifacts:copyFile', case: 'artifact-copy-unicode-path', args: ['t'.repeat(128), 'results/你好 report #1.png'] },
  { operation: 'attachments:download', case: 'attachment-download-uppercase-version-five-uuid', args: ['t'.repeat(128), 'ABCDEFAB-CDEF-5ABC-ABCD-ABCDEFABCDEF'] },
  { operation: 'attachments:remove', case: 'attachment-uppercase-version-five-uuid', args: ['t'.repeat(128), 'ABCDEFAB-CDEF-5ABC-ABCD-ABCDEFABCDEF'] },
  { operation: 'taskGroups:create', case: 'unicode-trimmed-title', args: [{ title: '\uFEFF🌱\uFEFF', task_ids: [task, 'task_second'] }] },
  { operation: 'taskGroups:review', case: 'max-escaped-feedback', args: [{ group_id: 'group_fixture', action: 'send_back', message: '\u0001'.repeat(4000), task_ids: [task] }] },
  { operation: 'heartbeat:enable', case: 'default-heartbeat-interval', args: [task] },
  { operation: 'heartbeat:getLogs', case: 'default-heartbeat-log-limit', args: [task] },
  { operation: 'heartbeat:writeFile', case: 'empty-heartbeat-file', args: [task, ''] },
  { operation: 'heartbeat:writeFile', case: 'maximum-escaped-heartbeat-file', args: [task, '\u0001'.repeat(128 * 1024)] },
  { operation: 'heartbeat:updateInterval', case: 'maximum-heartbeat-interval', args: [task, 525600] },
  { operation: 'worktree:setup', case: 'empty-task-workspace', args: [task, [], '', 'github'] },
  { operation: 'worktree:cleanup', case: 'omitted-remove-task-dir', args: [task, [], ''] },
  { operation: 'worktree:readFile', case: 'task-root-preview', args: [task, null, './docs/README.md'] },
  { operation: 'taskGroups:list', case: 'omitted-dissolved-filter', args: [project] },
  { operation: 'taskGroups:review', case: 'omitted-review-members', args: [{ group_id: 'group_fixture', action: 'approve' }] },
  { operation: 'project:getStatusHistory', case: 'omitted-history-query', args: [project] },
  { operation: 'project:getStatusHistory', case: 'history-limit-floored', args: [project, { limit: 1.5 }] },
  { operation: 'project:getStatusHistory', case: 'history-limit-lower-clamp', args: [project, { limit: 0 }] },
  { operation: 'project:getStatusHistory', case: 'history-limit-upper-clamp', args: [project, { limit: 1e100 }] },
  { operation: 'concurrency:pin', case: 'remove-user-pin', args: [project, agent, null] },
  { operation: 'concurrency:pin', case: 'hard-cap-pin', args: [project, agent, 10] },

  { operation: 'shell:readTextFile', case: 'workspace-unicode-path', args: ['/trusted-workspace/task_fixture/報告.md'] },
  { operation: 'shell:openPath', case: 'workspace-windows-path', args: ['C:\\workspace\\task_fixture\\report.md'] },
  { operation: 'shell:showItemInFolder', case: 'workspace-unc-path', args: ['\\\\server\\share\\task_fixture\\report.md'] },
  { operation: 'forgejo:setLogin', case: 'clear-forgejo-login', args: [null] },
  { operation: 'github:fetchPullRequestDetails', case: 'configured-forgejo-pr', args: ['https://forgejo.example.test/fixture/repo/pulls/42'] },
  ...['github', 'gitlab', 'forgejo'].map(provider => ({ operation: 'git:recordRepoProviders', case: `provider-map-${provider}`, args: [['team/subgroup/repo', 'fixture/other'], provider] })),
  ...['nemo-parakeet-tdt-0.6b-v3', 'sherpa-streaming-zipformer-en', 'nemo-fast-conformer-en-480ms', 'nemotron-streaming-en-560ms'].map(id => ({ operation: 'voice:selectModel', case: `finite-stt-${id}`, args: [id] })),
  ...['kitten-nano-en-v0_2', 'kokoro-en-v0_19'].map(id => ({ operation: 'voice:tts:selectModel', case: `finite-tts-${id}`, args: [id] })),
  ...['claudeCode', 'opencode', 'codex', 'pi', 'cursor', 'nodejs', 'npm', 'pnpm', 'git', 'gh', 'glab', 'tea', 'rtk'].map(name => ({ operation: 'agent-installer:install', case: `finite-installer-${name}`, args: [name] })),
  { operation: 'voice:setEndpointSilence', case: 'seconds-upper-bound', args: [10] },
  { operation: 'voice:tts:setSpeed', case: 'speed-lower-bound', args: [0.5] },
  { operation: 'voice:tts:setSpeed', case: 'speed-upper-bound', args: [2] },
  { operation: 'voice:tts:setMaxChars', case: 'characters-upper-bound', args: [6000] },
  { operation: 'voice:tts:setVoice', case: 'system-unicode-voice', args: ['system:café'] },
  { operation: 'voice:tts:setVoice', case: 'system-byte-boundary', args: ['system:' + 'x'.repeat(505)] },
  { operation: 'voice:tts:setVoice', case: 'empty-voice-preference', args: [''] },
  { operation: 'artifacts:read', case: 'retained-unicode-relative-path', args: [task, 'reports/café/readme.md'] },
  { operation: 'artifacts:read', case: 'relative-path-byte-boundary', args: [task, 'x'.repeat(2048)] },
  ...['15', '0', '', '0.5'].map(poll_interval_minutes => ({ operation: 'taskSource:update', case: `stored-bridge-interval-${poll_interval_minutes || 'default'}`, args: ['source_fixture', { plugin_id: 'connector-bridge', config: { poll_interval_minutes } }] })),
  { operation: 'agentSession:getTranscriptPage', case: 'snapshot-watermark-limit', args: [task, { version: 1, mode: 'snapshot', after: 10, watermark: 100, limit: 64 }] },
  { operation: 'agentSession:getTranscriptPage', case: 'delta-watermark-limit', args: [task, { version: 1, mode: 'delta', after: 10, watermark: 100, limit: 1 }] },
  { operation: 'agentSession:getTranscriptPage', case: 'delta-empty-watermark', args: [task, { version: 1, mode: 'delta', after: 0, watermark: 0 }] },
  { operation: 'project:update', case: 'nullable-git-fields', args: [project, { git_provider: null, git_org: null }] },
  { operation: 'project:update', case: 'forgejo-git-fields', args: [project, { git_provider: 'forgejo', git_org: 'fixture' }] },
  { operation: 'skills:create', case: 'all-optional-fields', args: [{ name: 'Fixture skill', description: '', content: 'Instructions', confidence: 0.5, uses: 3, last_used: null, tags: ['fixture'], preferred_model: null, project_id: null }] },
  { operation: 'skills:update', case: 'all-optional-fields', args: ['skill_fixture', { name: 'Fixture skill', description: '', content: 'Instructions', confidence: 0.75, uses: 4, last_used: '2026-10-13', tags: [], preferred_model: 'fixture/model', expected_version: 2 }] },
  { operation: 'skills:setProject', case: 'global-null-scope', args: ['skill_fixture', null] },
  { operation: 'db:getTasks', case: 'no-project-filter', args: [] },
  { operation: 'tasks:getCoordinatorTaskId', case: 'no-project-filter', args: [] },
  { operation: 'project:getAll', case: 'no-filter', args: [] },
  { operation: 'project:archive', case: 'omitted-default', args: [project] },
  { operation: 'commander:listSessions', case: 'no-filter', args: [] },
  { operation: 'commander:createSession', case: 'default-title', args: [] },
  { operation: 'commander:setActiveSession', case: 'active-session', args: [session] },
  { operation: 'commander:send', case: 'text-without-images', args: [session, 'Fixture'] },
  { operation: 'commander:send', case: 'image-only', args: [session, '', [image]] },
  { operation: 'agentSession:start', case: 'omitted-optionals', args: [agent, task] },
  { operation: 'agentSession:send', case: 'task-addressed-empty-native-id', args: ['', 'Fixture', task, agent] },
  { operation: 'agentSession:approve', case: 'permission-without-answer', args: [session, true, undefined, 'permission', 'native_permission_fixture'] },
  { operation: 'agentSession:sendByTaskId', case: 'persisted-attachment', args: [task, 'Fixture', [{ id: 'attachment_fixture', filename: 'fixture.txt', size: 4, mime_type: 'text/plain' }]] },
  { operation: 'agentConfig:getProviders', case: 'default-provider', args: [] },
  { operation: 'agentConfig:getProviders', case: 'backend-only', args: [undefined, 'claude-code'] },
  { operation: 'terminal:create', case: 'owner-default-cwd', args: ['terminal:fixture', 1, 4096] },
  { operation: 'terminal:kill', case: 'no-expected-pid', args: ['terminal:fixture'] },
  { operation: 'terminal:getCwd', case: 'no-expected-pid', args: ['terminal:fixture'] },
  { operation: 'terminal:getBuffer', case: 'default-lines', args: ['terminal:fixture'] },
  { operation: 'db:updateTask', case: 'wide-output-json', args: [task, { output_fields: [{ id: 'output_fixture', name: 'Wide JSON', type: 'json', value: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`field_${index}`, index])) }] }] },
  { operation: 'db:updateTask', case: 'large-output-json-array', args: [task, { output_fields: [{ id: 'output_fixture', name: 'Array JSON', type: 'json', value: Array.from({ length: 5000 }, (_, index) => index) }] }] },
  { operation: 'db:updateTask', case: 'depth-40-output-json', args: [task, { output_fields: [{ id: 'output_fixture', name: 'Deep JSON', type: 'json', value: deepOutput }] }] },
  { operation: 'agent:update', case: 'frame-bounded-large-config', args: [agent, { config: largeConfig }] },
  { operation: 'agent:create', case: 'finite-api-key-write', args: [{ name: 'Fixture key owner', config: { coding_agent: 'pi', api_keys: { openai: 'synthetic-fixture-key', anthropic: '', cursor: '__21x_api_key_set__' } } }] },
  { operation: 'agent:update', case: 'finite-api-key-boundary', args: [agent, { config: { api_keys: { openai: 'x'.repeat(16384) } } }] },
  { operation: 'mcp:update', case: 'masked-credential-preservation', args: ['mcp.fixture:one', { headers: { Authorization: '__21x_mcp_secret_set__', 'X-Empty': '' }, environment: { FIXTURE_TOKEN: '__21x_mcp_secret_set__' } }] },
  { operation: 'mcp:testConnection', case: 'local-probe-without-saved-id', args: [{ name: 'Fixture probe', command: 'fixture-mcp', args: ['--probe'] }] },
  { operation: 'taskSource:getAll', case: 'all-authorized-projects', args: [] },
  { operation: 'taskSource:getAll', case: 'empty-project-filter', args: [''] },
  { operation: 'taskSource:create', case: 'linear-marker-config', args: [{ name: 'Fixture Linear', mcp_server_id: 'server_fixture', plugin_id: 'linear', config: { _setup_link: 'https://linear.example.test/setup', redirect_uri: 'twentyonex://oauth/callback', client_id: 'fixture-client', client_secret: '__21x_api_key_set__', scope: 'read', assignee_id: 'fixture-user' }, list_tool: '', list_tool_args: {}, update_tool: '', update_tool_args: {} }] },
  { operation: 'taskSource:create', case: 'hubspot-config', args: [{ name: 'Fixture HubSpot', mcp_server_id: null, plugin_id: 'hubspot', config: { auth_type: 'private_app', _oauth_setup_link: 'https://hubspot.example.test/setup', client_id: 'fixture-client', pipeline_id: 'fixture-pipeline', owner_id: 'fixture-owner', client_secret: '__21x_api_key_set__', access_token: '__21x_api_key_set__' } }] },
  { operation: 'taskSource:create', case: 'forgejo-config', args: [{ name: 'Fixture Forgejo', mcp_server_id: null, plugin_id: 'forgejo-issues', config: { login: 'fixture', owner: 'fixture', repo: 'proof', state: 'all', assignee: 'fixture-user', labels: '' } }] },
  { operation: 'taskSource:create', case: 'notion-filter-config', args: [{ name: 'Fixture Notion', mcp_server_id: null, plugin_id: 'notion', config: { data_source_id: 'external:data-source', filters: [{ property: 'Status', type: 'select', values: ['Open'] }], next_statuses: ['In progress', 'Done'], completion_status: 'Done', api_token: '__21x_api_key_set__' } }] },
  { operation: 'taskSource:create', case: 'youtrack-multiselect-config', args: [{ name: 'Fixture YouTrack', mcp_server_id: null, plugin_id: 'youtrack', config: { server_url: 'https://youtrack.example.test', project: 'PROOF', assignee: ['fixture-user'], state: ['Open'], priority: ['Major'], issue_type: ['Task'], custom_query: '', api_token: '__21x_api_key_set__' } }] },
  { operation: 'taskSource:create', case: 'connector-fractional-poll-config', args: [{ name: 'Fixture connector', mcp_server_id: null, plugin_id: 'connector-bridge', config: { piece_name: '@activepieces/piece-trello', connector_instance_id: 'connector_fixture', props: { board_id: 'external-board', filter_query: '' }, poll_interval_minutes: 0.5 } }] },
  { operation: 'taskSource:update', case: 'config-without-plugin', args: ['source_fixture', { config: { api_token: '__21x_api_key_set__', next_statuses: 'Done' } }] },
  { operation: 'taskSource:update', case: 'finite-source-credential-write', args: ['source_fixture', { plugin_id: 'notion', config: { api_token: 'synthetic\nfixture-credential' } }] },
  { operation: 'taskSource:update', case: 'finite-source-credential-boundary', args: ['source_fixture', { config: { api_token: 'x'.repeat(16384) } }] },
  { operation: 'taskSource:reassign', case: 'clear-assignees', args: [task, [], ''] },
  { operation: 'connectors:ensureInstance', case: 'new-mapped-todoist-instance', args: ['@activepieces/piece-todoist'] },
  { operation: 'connectors:setCredentials', case: 'secret-text-default-storage', args: ['connector.fixture:one', { secret: 'synthetic-fixture-secret' }] },
  { operation: 'connectors:setCredentials', case: 'field-byte-boundary', args: ['connector.fixture:one', { secret: 'x'.repeat(4096) }, 'persistent'] },
  { operation: 'connectors:oauthConnect', case: 'public-client-without-secret', args: ['connector.fixture:one', { clientId: 'fixture-client' }] },
  { operation: 'connectors:oauthConnect', case: 'registered-client-owned-input', args: ['connector.fixture:one', {}] },
  { operation: 'connectors:oauthConnect', case: 'typed-omitted-client-secret', args: ['connector.fixture:one', { clientId: 'fixture-client', clientSecret: undefined }, 'persistent'] },
  { operation: 'connectors:setCredentials', case: 'typed-omitted-unused-secret', args: ['connector.fixture:one', { username: 'fixture-user', password: 'synthetic-fixture-password', secret: undefined }, 'session'] },
  { operation: 'plugin:resolveOptions', case: 'fifth-only-source-scope', args: ['linear', 'users', {}, undefined, 'source_fixture'] },
  { operation: 'plugin:resolveOptions', case: 'raw-declared-resolver-credential', args: ['notion', 'data_sources', { api_token: 'synthetic\nfixture-credential' }] },
  { operation: 'plugin:resolveOptions', case: 'resolver-credential-byte-boundary', args: ['youtrack', 'users', { api_token: 'x'.repeat(16384) }] },
  ...Object.entries({ linear: ['users'], hubspot: ['owners', 'pipelines'], 'github-issues': ['owners', 'repos'], 'forgejo-issues': ['logins', 'owners', 'repos'], notion: ['data_sources', 'status_options', 'data_source_properties'], youtrack: ['projects', 'users', 'states', 'priorities', 'types'], 'connector-bridge': ['pieces'] }).flatMap(([pluginId, resolvers]) => resolvers.map(resolverKey => ({ operation: 'plugin:resolveOptions', case: `resolver-${pluginId}-${resolverKey}`, args: [pluginId, resolverKey, {}] }))),
  { operation: 'sessionContext:getSnapshot', case: 'commander-context-scope', args: [{ kind: 'commander', ownerId: session }] },
  ...['off', 'observe', 'on'].map(mode => ({ operation: 'sessionContext:setPolicy', case: `rollover-mode-${mode}`, args: [{ ...policy, mode }] })),
  { operation: 'sessionContext:setPolicy', case: 'policy-max-boundaries', args: [{ mode: 'on', contextRatio: 1, compactions: 1000000, wakeups: 1000000, turns: 1000000, maxAgeDays: 3650 }] },
  { operation: 'sessionContext:setPolicy', case: 'policy-fractional-age', args: [{ mode: 'off', contextRatio: 0.001, compactions: 1, wakeups: 1, turns: 1, maxAgeDays: 0.125 }] },
  { operation: 'claudePlugin:addMarketplaceSource', case: 'default-github-source', args: [{ name: 'Fixture default', source_url: 'fixture/marketplace' }] },
  { operation: 'claudePlugin:addMarketplaceSource', case: 'https-catalog-source', args: [{ name: 'Fixture HTTPS', source_type: 'url', source_url: 'https://marketplace.example.test/catalog.json' }] },
  { operation: 'claudePlugin:addMarketplaceSource', case: 'explicit-local-catalog-source', args: [{ name: 'Fixture local', source_type: 'local', source_url: '/synthetic-fixture/marketplace' }] },
  { operation: 'claudePlugin:addMarketplaceSource', case: 'typed-omitted-source-options', args: [{ name: 'Fixture optional', source_type: undefined, source_url: 'fixture/marketplace', auto_update: undefined }] },
  { operation: 'claudePlugin:discoverPlugins', case: 'unfiltered-discovery', args: [] },
  { operation: 'claudePlugin:discoverPlugins', case: 'empty-discovery-query', args: [''] },
  { operation: 'claudePlugin:installPlugin', case: 'default-user-scope', args: ['fixture-plugin', 'marketplace.fixture:one'] },
  { operation: 'claudePlugin:installPlugin', case: 'maximum-safe-plugin-name', args: ['x'.repeat(128), 'marketplace.fixture:one', 'user'] },
  { operation: 'mobile:setAccess', case: 'mobile-enabled-only', args: [{ enabled: true }] },
  { operation: 'mobile:setAccess', case: 'mobile-lan-opt-in', args: [{ lanAccess: true, sessionIdleDays: 365 }] },
  { operation: 'mobile:setAccess', case: 'mobile-fractional-idle', args: [{ sessionIdleDays: 0.125 }] },
  { operation: 'mobile:setAccess', case: 'mobile-typed-omitted-option', args: [{ enabled: false, lanAccess: undefined, sessionIdleDays: undefined }] },
  { operation: 'mobile:setCustomUrl', case: 'mobile-loopback-custom-url', args: ['http://127.0.0.1:3210'] },
  { operation: 'mobile:setCustomUrl', case: 'mobile-ipv6-custom-url', args: ['https://[::1]:3210/access'] },
  { operation: 'mobile:setCustomUrl', case: 'mobile-empty-query-base', args: ['https://mobile.example.test/access?'] },
  { operation: 'mobile:setCustomUrl', case: 'mobile-empty-fragment-base', args: ['https://mobile.example.test/access#'] },
  { operation: 'mobile:setCustomUrl', case: 'mobile-address-byte-boundary', args: ['https://mobile.example.test/' + 'x'.repeat(2048 - 'https://mobile.example.test/'.length)] },
  { operation: 'mobile:revokeSession', case: 'mobile-namespaced-session-id', args: ['mobile.fixture:one'] },
  { operation: 'chat:start', case: 'tool-history', args: [{ messages: [{ role: 'user', content: 'Fixture request' }, { role: 'assistant', content: '', toolCalls: [{ id: 'call_fixture', name: 'fixture_tool', input: { projectId: project } }] }, { role: 'tool', toolCallId: 'call_fixture', name: 'fixture_tool', content: 'Fixture result', isError: false }], maxToolCalls: 32 }] },
  ...PRODUCTION_SETTINGS_KEYS.map(key => ({ operation: 'settings:get', case: `setting-${key}`, args: [key] })),
  ...PRODUCTION_ENV_KEYS.map(key => ({ operation: 'env:get', case: `marker-${key}`, args: [key] })),
  { operation: 'settings:get', case: 'project-canvas', args: [`canvas_state:${project}`] },
  { operation: 'settings:set', case: 'project-canvas-value', args: [`canvas_state:${project}`, JSON.stringify({ nodes: [], viewport: { zoom: 1 } })] }
]
export interface ProductionRequestCorpus { version: 1; operations: string[]; requests: Array<{ operation: string; case: string; payload: JsonValue }> }
export function createProductionRequestCorpus(): ProductionRequestCorpus {
  const operations = Object.keys(PROOF_COMMAND_CODECS).sort(), fixtures = Object.keys(PRODUCTION_REQUEST_ARGUMENTS).sort()
  if (operations.length !== 229 || JSON.stringify(operations) !== JSON.stringify(fixtures)) throw new Error('Production command corpus must cover the exact finite codec map')
  const inputs = [...Object.entries(PRODUCTION_REQUEST_ARGUMENTS).map(([operation, args]) => ({ operation, args, case: 'baseline' })), ...PRODUCTION_REQUEST_VARIANTS]
  const requests = inputs.map(row => {
    const codec = PROOF_COMMAND_CODECS[row.operation as keyof typeof PROOF_COMMAND_CODECS]
    if (!codec || !codec.validateArguments(row.args)) throw new Error(`Invalid explicit fixture: ${row.operation}/${row.case}`)
    const payload = codec.encodeArguments(row.args as never)
    if (!codec.validateArguments(codec.decodeArguments(payload))) throw new Error(`Encoded fixture failed actual codec: ${row.operation}/${row.case}`)
    return { operation: row.operation, case: row.case, payload }
  })
  return { version: 1, operations, requests }
}
/** Coordinator/test harness selects the artifact destination, never desktop RPC. */
export async function writeProductionRequestCorpus(path: string): Promise<ProductionRequestCorpus> {
  const corpus = createProductionRequestCorpus()
  await writeFile(path, JSON.stringify(corpus, null, 2) + '\n', { mode: 0o600 })
  return corpus
}
