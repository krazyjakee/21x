import { defineConfig } from 'vitest/config'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const pins = JSON.parse(readFileSync(join(root, 'scripts/tauri-runtime.json'), 'utf8'))
if (process.versions.electron || process.version !== `v${pins.nodeVersion}` || !process.env.TAURI_SQLITE_MODULE) {
  throw new Error('Use scripts/tauri-test.mjs with staged standalone resources')
}
const sqlite = realpathSync(process.env.TAURI_SQLITE_MODULE)
const expected = realpathSync(join(root, 'src-tauri/resources/service/node_modules/better-sqlite3'))
const metadata = JSON.parse(readFileSync(join(sqlite, 'package.json'), 'utf8'))
if (sqlite !== expected || metadata.name !== 'better-sqlite3' || metadata.version !== pins.nativeDependencies['better-sqlite3']) {
  throw new Error('The standalone suite requires the explicitly staged SQLite package')
}
const resolveOptions = { alias: [
  { find: /^better-sqlite3$/, replacement: join(sqlite, 'lib/index.js') },
  { find: /^electron(?:$|\/)/, replacement: join(root, 'test/forbid-electron.ts') },
  { find: '@shared', replacement: join(root, 'src/shared') },
  { find: '@', replacement: join(root, 'src/renderer/src') }
] }
const mainFiles = [
  'src/main/agent-manager-cli-configuration.test.ts',
  'src/main/agent-installer/portable-installation.test.ts',
  'src/main/agent-installer/portable-detection-controls.test.ts',
  'src/main/task-attachment-file-owner.test.ts', 'src/main/attachment-execution-owner.test.ts', 'src/main/chat/task-image-attachments.test.ts',
  'src/main/cli-mcp-config/*.test.ts',
  'src/service/**/*.test.ts', 'src/main/agent-manager-configuration.test.ts',
  'src/main/agent-manager-scoped-approval.test.ts', 'src/main/adapters/shared/json-rpc-acknowledgement.test.ts',
  'src/main/platform/native-application-key-store.test.ts',
  'src/main/platform/credential-migration.test.ts', 'src/main/platform/record-credential-conversion.test.ts',
  'src/main/platform/profile-migration-rehearsal.test.ts', 'src/main/platform/profile-migration-settings-integration.test.ts',
  'src/main/tunnel-manager-core.test.ts',
  'src/main/oauth/oauth-manager-host.test.ts', 'src/main/worktree-manager-host.test.ts', 'src/main/worktree-manager-runtime.test.ts', 'src/main/workspace-cleanup-scheduler-runtime.test.ts', 'src/main/platform/secret-storage.test.ts',
  'src/main/git-provider-process-owner.test.ts', 'src/main/github-manager.test.ts', 'src/main/gitlab-manager.test.ts', 'src/main/forgejo-manager.test.ts', 'src/main/worktree-directory-authority.test.ts',
  'src/main/workspace-file-owner.test.ts', 'src/main/heartbeat-file-owner.test.ts', 'src/main/heartbeat-preflight-owned.test.ts', 'src/main/agent-manager/task-group-request-scope.test.ts',
  'src/main/agent-manager-task-group-request.test.ts', 'src/main/agent-manager/workspace-docs-request-scope.test.ts',
  'test/tauri-runtime.test.ts', 'test/tauri-terminal-native.test.ts',
  'src/main/node-worker-runtime.test.ts',
  'src/main/voice/voice-session-manager-core.test.ts',
  'src/main/voice/voice-worker-client.test.ts', 'src/main/voice/voice-model-manager.test.ts', 'src/main/voice/voice-runtime-installer.test.ts',
  'src/main/voice/voice-model-download-policy.test.ts', 'src/main/voice/voice-model-inventory-owner.test.ts',
  'src/main/voice/voice-speech-service.test.ts', 'src/main/voice/voice-tts-worker-client.test.ts',
  'src/main/voice/voice-tts-model-manager.test.ts', 'src/main/voice/voice-system-voices.test.ts',
  'src/main/adapters/opencode-adapter.test.ts',
  'src/main/adapters/claude-code-adapter.test.ts',
  'src/main/adapters/codex-app-server-adapter.test.ts',
  'src/main/adapters/acp-adapter.test.ts',
  'src/main/adapters/pi-adapter.test.ts',
  'src/main/adapters/claude-code-history.test.ts',
  'src/main/adapters/permission-mode.test.ts',
  'src/main/artifacts.test.ts',
  'src/main/agent-installer/installer-network.test.ts',
  'src/main/agent-installer/installer-process.test.ts',
  'src/main/task-api-server.test.ts', 'src/main/task-api/skill-routes.test.ts',
  'src/main/task-api-lifetime.test.ts',
  'src/main/task-api/task-group-routes.test.ts', 'src/main/mcp-servers/task-management-groups.test.ts',
  'src/main/mcp-servers/task-group-stdio.test.ts', 'src/main/task-groups/service.test.ts',
  'src/main/database/task-groups.test.ts', 'src/main/database/task-groups-migration.test.ts',
  'src/main/task-mcp-endpoint.test.ts',
  'src/main/mobile-api-server.test.ts',
  'src/main/mobile-api-lifetime.test.ts',
  'src/main/task-automation-scheduler.test.ts', 'src/main/task-automation-lifetime.test.ts',
  'src/main/captain-waker.test.ts', 'src/main/captain-waker-lifetime.test.ts',
  'src/main/recurrence-scheduler.test.ts', 'src/main/recurrence-scheduler-lifetime.test.ts',
  'src/main/scheduled-coordination.test.ts', 'src/main/scheduled-coordination-lifetime.test.ts',
  'src/main/commander/commander-service.test.ts', 'src/main/commander/captain-delivery.test.ts', 'src/main/commander/commander-lifetime.test.ts',
  'src/main/commander/prompts.test.ts', 'src/main/commander/report-tools.test.ts',
  'src/main/prompts/captain.test.ts', 'src/main/pull-request-merge.test.ts', 'src/main/issue-writes.test.ts',
  'src/main/commander/project-tools.test.ts', 'src/main/commander/skill-tools.test.ts',
  'src/main/commander/action-results.test.ts', 'src/main/commander/commander-store.test.ts',
  'src/main/commander/commander-input-mode.test.ts', 'src/main/ipc/commander-actions.test.ts',
  'src/main/database/commander-actions-migration.test.ts',
  'src/main/commander/commander-accounting.test.ts',
  'src/main/commander/activity-observations.test.ts', 'src/main/commander/commander-managed.test.ts',
  'src/main/sessions/chat-engine.test.ts', 'src/main/sessions/roles/commander.test.ts',
  'src/main/sessions/compaction.test.ts', 'src/main/adapters/adapter-compaction.test.ts',
  'src/main/agent-manager-compaction.test.ts',
  'src/main/sessions/adapter-engine.test.ts', 'src/main/agent-manager-captain-managed.test.ts',
  'src/main/sessions/adapter-engine-accounting.test.ts', 'src/main/agent-manager-task-managed.test.ts',
  'src/main/agent-handoff-token-budget.test.ts', 'src/main/agent-manager-activity-outcomes.test.ts',
  'src/main/captain-waker-managed.test.ts', 'src/main/database/session-handoff-migration.test.ts',
  'src/main/sessions/handoff.test.ts', 'src/main/sessions/memory.test.ts', 'src/main/sessions/compaction-policy.test.ts',
  'src/main/sessions/context-service.test.ts', 'src/main/ipc/session-context.test.ts',
  'src/main/commander/commander-rollover.test.ts',
  'src/main/sessions/captain-rollover.test.ts', 'src/main/agent-manager-captain-rollover.test.ts', 'src/main/task-send-lock.test.ts',
  'src/main/sessions/token-accounting.test.ts', 'src/main/sessions/managed-session.test.ts',
  'src/main/adapters/adapter-usage.test.ts',
  'src/main/voice/commander-voice.test.ts',
  'src/main/chat/chat-runtime.test.ts', 'src/main/chat/chat-runtime-lifetime.test.ts',
  'src/main/claude-plugin-manager.test.ts', 'src/main/claude-plugin-lifetime.test.ts',
  'src/main/claude-plugins/sources.test.ts', 'src/main/claude-plugins/containment.test.ts',
  'src/main/claude-plugins/resources.containment.test.ts',
  'src/main/agent-manager/provider-failure.test.ts', 'src/main/sessions/provider-recovery-store.test.ts',
  'src/main/agent-manager-provider-recovery.test.ts',
  'src/main/agent-manager/mcp-probe-service.test.ts', 'src/main/mcp-client-messages.test.ts',
  'src/main/secret-broker-core.test.ts', 'src/main/secret-shell.test.ts',
  'src/main/terminal-service-core.test.ts', 'src/main/terminal-process.test.ts',
  'src/main/overdue-notifier.test.ts',
  'src/main/workspace-cleanup-scheduler.test.ts', 'src/main/workspace-cleanup-scheduler-lifetime.test.ts',
  'src/main/heartbeat-scheduler.test.ts', 'src/main/heartbeat-scheduler-lifetime.test.ts',
  'src/main/agent-installer/detect.test.ts', 'src/main/agent-installer/install.test.ts',
  'src/main/sync-manager-lifetime.test.ts',
  'src/main/sync-manager.test.ts',
  'src/main/connectors/piece-host/piece-host.test.ts',
  'src/main/connectors/piece-host/node-transport.test.ts',
  'src/main/connectors/piece-host/packaged-resources.test.ts',
  'src/main/connectors/oauth-lifetime.test.ts',
  'src/main/connectors/credential-admission.test.ts',
  'src/main/connectors/connector-store.test.ts', 'src/main/connectors/credentials.test.ts',
  'src/main/connectors/ssrf.test.ts', 'src/main/connectors/piece-host/tls-guard.test.ts',
  'src/main/connectors/bridge/scheduler-lifetime.test.ts',
  'src/main/connectors/bridge/engine-lifetime.test.ts',
  'src/main/connectors/bridge/service.test.ts',
  'src/main/connectors/bridge/runtime-lifetime.test.ts',
  'src/main/connectors/bridge/bridge.test.ts', 'src/main/connectors/bridge/trello-poc.test.ts',
  'src/main/connectors/bridge/todoist-oauth.test.ts',
  'src/main/oauth/local-oauth-server.test.ts',
  'src/main/oauth/providers/connector-oauth-provider.test.ts',
  'src/main/agent-manager/transcript-events-core.test.ts', 'src/main/database-transcript-page.test.ts', 'src/main/transcript-events.test.ts', 'src/main/transcript-page-authority.test.ts',
  'src/shared/**/*.test.ts',
  'scripts/tauri-inventory.test.ts', 'scripts/tauri-contracts.test.ts', 'scripts/tauri-stage-production.test.ts', 'scripts/production-contracts-proof.test.ts', 'scripts/native-notification-contracts-proof.test.ts',
  'scripts/artifact-frame-proof.test.ts',
  'scripts/production-workspace-cleanup-git-fixture.test.ts',
  'scripts/production-task-feedback-proof.test.ts',
  'scripts/activity-process-proof.test.ts',
  'scripts/database-proof.test.ts', 'scripts/configuration-proof.test.ts', 'scripts/agent-desktop-proof.test.ts',
  ...(process.env.TAURI_PRODUCTION_SERVICE_PROOFS === '1' ? ['scripts/production-service-proof.test.ts'] : []),
  ...(process.env.TAURI_TERMINAL_PROOFS === '1' ? [
    'scripts/production-terminal-proof.test.ts', 'scripts/production-payload-recovery-proof.test.ts'
  ] : []),
  ...(process.env.TAURI_STANDALONE_SERVICE_PROOFS === '1' ? [
    'scripts/database-service-proof.test.ts', 'scripts/configuration-service-proof.test.ts', 'scripts/transcript-page-proof.test.ts',
    'scripts/connector-worker-service-proof.test.ts'
  ] : [])
]
export default defineConfig({
  root, resolve: resolveOptions,
  test: {
    maxWorkers: 1,
    projects: [
      { resolve: resolveOptions, test: { name: 'portable-main', environment: 'node', include: mainFiles,
        setupFiles: [join(root, 'test/setup-tauri.ts')] } },
      { resolve: resolveOptions, esbuild: { jsx: 'automatic' }, test: { name: 'portable-renderer', environment: 'happy-dom',
        include: ['src/renderer/src/lib/desktop-client.test.ts', 'src/renderer/src/lib/transcript-pagination.test.ts', 'src/renderer/src/lib/tauri-task-slice.test.ts',
          'src/renderer/src/lib/terminal-session.test.ts', 'src/renderer/src/lib/tauri-desktop-transport.test.ts', 'src/renderer/src/lib/desktop-api.test.ts', 'src/renderer/src/lib/native-desktop-host.test.ts', 'src/renderer/src/lib/shared-ipc-listeners.test.ts',
          'src/renderer/src/components/artifacts/viewers/HtmlArtifactView.test.tsx',
          'src/renderer/src/components/layout/DesktopHostStatus.test.tsx', 'src/renderer/src/hooks/use-title-bar-overlay-theme.test.tsx', 'src/renderer/src/stores/commander-desktop-recovery.test.ts',
          'src/renderer/src/components/ui/Markdown.native-attachments.test.tsx', 'src/renderer/src/components/ui/Markdown.test.tsx', 'src/renderer/src/components/ui/Markdown.stability.test.tsx',
          'src/renderer/src/stores/native-configuration-recovery.test.ts',
          'src/renderer/src/stores/native-resource-catalog-recovery.test.tsx', 'src/renderer/src/components/settings/forms/TaskSourceFormDialog.test.tsx', 'src/renderer/src/lib/native-attachment-drop-owner.test.ts', 'src/shared/native-attachment-drop.test.ts', 'src/renderer/src/stores/mcp-store.test.ts', 'src/renderer/src/stores/task-source-store.test.ts',
          'src/renderer/src/components/projects/ProjectEditorDialog.native.test.tsx', 'src/renderer/src/lib/project-editor.test.ts',
          'src/renderer/src/hooks/native-overdue.test.tsx', 'src/renderer/src/hooks/use-snooze-tick.test.ts', 'src/renderer/src/stores/skill-store.test.ts',
          'src/renderer/src/components/commander/CommanderChatPane.images.test.tsx', 'src/renderer/src/components/dashboard/DashboardWorkspace.test.tsx',
          'src/renderer/src/stores/production-list-recovery.test.ts', 'src/renderer/src/stores/native-agent-activity.test.ts', 'src/renderer/src/stores/agent-store.test.ts', 'src/renderer/src/stores/task-store.test.ts',
          'src/renderer/src/stores/project-store.test.ts', 'src/renderer/src/stores/settings-store.test.ts', 'src/renderer/src/stores/overview-store.test.ts', 'src/renderer/src/stores/task-group-store.test.ts',
          'src/renderer/src/stores/canvas-store.test.ts', 'src/renderer/src/stores/drawing-store.test.ts',
          'src/renderer/src/components/canvas/native-browser-retirement.test.tsx', 'src/renderer/src/components/canvas/browser-retirement.test.tsx', 'src/renderer/src/components/tasks/native-attachment-ui.test.tsx', 'src/renderer/src/components/tasks/native-task-hierarchy.test.tsx', 'src/renderer/src/components/tasks/TaskWorkspace.test.tsx', 'src/renderer/src/components/agents/transcript/TranscriptComposer.images.test.tsx', 'src/renderer/src/components/settings/native-general-settings.test.tsx', 'src/renderer/src/components/update/UpdateDialog.test.tsx'], setupFiles: [join(root, 'test/setup-renderer.ts')] } }
    ]
  }
})
