import { ipcMain } from 'electron'
import type { CreateSkillData, UpdateSkillData, CreateSecretData, UpdateSecretData } from '../database'
import type { IpcDeps } from './deps'
import { isApiKeySetting } from '../database/serializers'

/**
 * The renderer only needs to know whether an API key is saved, never its value.
 * Non-empty keys are replaced by this marker on the way out.
 */
export const API_KEY_SET_MARKER = '__21x_api_key_set__'

function forRenderer(key: string, value: string): string {
  return isApiKeySetting(key) && value ? API_KEY_SET_MARKER : value
}

/** Key/value settings plus the skill and secret libraries. */
export function registerSettingsHandlers({ db }: IpcDeps): void {
  ipcMain.handle('settings:get', (_, key: string) => {
    const value = db.getSetting(key)
    return value === undefined ? null : forRenderer(key, value)
  })

  ipcMain.handle('settings:set', (_, key: string, value: string) => {
    // Echoing the marker back must not overwrite the real key.
    if (isApiKeySetting(key) && value === API_KEY_SET_MARKER) return
    db.setSetting(key, value)
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

  ipcMain.handle('skills:getAll', () => db.getSkills())
  ipcMain.handle('skills:create', (_, data: CreateSkillData) => db.createSkill(data))
  ipcMain.handle('skills:update', (_, id: string, data: UpdateSkillData) => db.updateSkill(id, data))
  ipcMain.handle('skills:delete', (_, id: string) => db.deleteSkill(id))

  ipcMain.handle('secrets:getAll', () => db.getSecrets())
  ipcMain.handle('secrets:create', (_, data: CreateSecretData) => db.createSecret(data))
  ipcMain.handle('secrets:update', (_, id: string, data: UpdateSecretData) => db.updateSecret(id, data))
  ipcMain.handle('secrets:delete', (_, id: string) => db.deleteSecret(id))
}
