import { BrowserWindow, ipcMain } from 'electron'
import type { CreateSkillData, UpdateSkillData, CreateSecretData, UpdateSecretData } from '../database'
import { guardedIpcSend } from '../guarded-ipc-send'
import type { IpcDeps } from './deps'
import { isApiKeySetting } from '../database/serializers'
import { MAX_CONCURRENT_AGENT_SESSIONS_SETTING } from '../agent-manager/admission'

/**
 * The renderer only needs to know whether an API key is saved, never its value.
 * Non-empty keys are replaced by this marker on the way out.
 */
export const API_KEY_SET_MARKER = '__21x_api_key_set__'

function forRenderer(key: string, value: string): string {
  return isApiKeySetting(key) && value ? API_KEY_SET_MARKER : value
}

/** A skill changed outside the Skills view (the Commander's skill tools, #74): the store refetches. */
export const SKILLS_CHANGED_CHANNEL = 'skills:changed'

export function broadcastSkillsChanged(event: { skillId: string; kind: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) guardedIpcSend(win.webContents, SKILLS_CHANGED_CHANNEL, event)
  }
}

/** Key/value settings plus the skill and secret libraries. */
export function registerSettingsHandlers({ db, agentManager }: IpcDeps): void {
  ipcMain.handle('settings:get', (_, key: string) => {
    const value = db.getSetting(key)
    return value === undefined ? null : forRenderer(key, value)
  })

  ipcMain.handle('settings:set', (_, key: string, value: string) => {
    // Echoing the marker back must not overwrite the real key.
    if (isApiKeySetting(key) && value === API_KEY_SET_MARKER) return
    db.setSetting(key, value)
    if (key === MAX_CONCURRENT_AGENT_SESSIONS_SETTING) agentManager.drainStartQueue()
  })

  ipcMain.handle('settings:getAll', () => {
    // Mobile pairing keys are live credentials, not UI settings.
    return Object.fromEntries(
      Object.entries(db.getAllSettings())
        .filter(([k]) => !k.startsWith('mobile_init_code_'))
        .map(([k, v]) => [k, forRenderer(k, v)])
    )
  })

  ipcMain.handle('env:get', (_, key: string) => process.env[key] ?? null)

  // The Skills view is the user's own hand: it sees every scope and needs no
  // confirmation step (#74). Scope changes go through skills:setProject only.
  ipcMain.handle('skills:getAll', () => db.getSkills())
  ipcMain.handle('skills:create', (_, data: CreateSkillData) => {
    if (data.project_id && !db.getProject(data.project_id)) throw new Error(`Project not found: ${data.project_id}`)
    return db.createSkill(data)
  })
  // A stale expected_version surfaces as a rejected invoke; the editor shows the message.
  ipcMain.handle('skills:update', (_, id: string, data: UpdateSkillData) => db.updateSkill(id, data))
  ipcMain.handle('skills:delete', (_, id: string) => db.deleteSkill(id))
  ipcMain.handle('skills:setProject', (_, id: string, projectId: string | null) => {
    if (projectId && !db.getProject(projectId)) throw new Error(`Project not found: ${projectId}`)
    return db.setSkillProject(id, projectId)
  })

  ipcMain.handle('secrets:getAll', () => db.getSecrets())
  ipcMain.handle('secrets:create', (_, data: CreateSecretData) => db.createSecret(data))
  ipcMain.handle('secrets:update', (_, id: string, data: UpdateSecretData) => db.updateSecret(id, data))
  ipcMain.handle('secrets:delete', (_, id: string) => db.deleteSecret(id))
}
