import { Notification, powerSaveBlocker } from 'electron'
import { guardedIpcSend } from '../guarded-ipc-send'
import { getSecretBrokerPort, registerSecretSession, unregisterSecretSession, writeSecretShellWrapper } from '../secret-broker'
import { getTaskApiPort, getTaskApiToken, waitForTaskApiServer } from '../task-api-server'
import { buildTaskMcpUrl } from '../task-mcp-endpoint'
import { createAdapter, isCodexAppServerAdapter } from './adapter-factory'
import type { AgentManagerHost } from './host'

/** Shipping defaults stay in the Electron wrapper, outside the service graph. */
export function electronAgentManagerHost(): AgentManagerHost {
  return {
    renderer: { kind: 'native', send: guardedIpcSend },
    notifications: {
      kind: 'native',
      isSupported: () => Notification.isSupported(),
      show: ({ title, body, onClick }) => {
        const notification = new Notification({ title, body })
        notification.on('click', onClick)
        notification.show()
      }
    },
    // ELECTRON_RUN_AS_NODE intentionally has no energy API, as before.
    energy: typeof powerSaveBlocker?.start === 'function'
      ? { kind: 'native', start: () => powerSaveBlocker.start('prevent-app-suspension'), stop: id => powerSaveBlocker.stop(id) }
      : { kind: 'unsupported' },
    secrets: {
      kind: 'broker', getPort: getSecretBrokerPort,
      register: registerSecretSession, unregister: unregisterSecretSession,
      writeShellWrapper: writeSecretShellWrapper
    },
    configuredMcp: 'enabled',
    managedTaskMcp: {
      kind: 'server', waitUntilReady: waitForTaskApiServer,
      buildConfig: options => {
        const port = getTaskApiPort()
        if (!port) {
          console.warn('[AgentManager] buildTaskManagementMcpConfig - task API port is null; task-management tools unavailable')
          return null
        }
        return {
          type: 'http',
          url: buildTaskMcpUrl(port, getTaskApiToken(), {
            taskId: options?.taskId ?? options?.taskScope?.taskId,
            parentTaskId: options?.taskScope?.parentTaskId,
            projectId: options?.taskScope ? undefined : options?.projectId,
            artifactTaskId: options?.artifactTaskId,
            agentId: options?.agentId,
            sessionNonce: options?.sessionNonce
          })
        }
      }
    },
    createAdapter,
    isCodexAppServerAdapter,
    captainSummaryProvider: async source => {
      const { createChatProviderFromSettings } = await import('../chat/provider-factory')
      return createChatProviderFromSettings(source)
    }
  }
}
