import { ipcMain } from 'electron'
import type { CreateSkillData, UpdateSkillData, CreateSecretData, UpdateSecretData } from '../database'
import type { IpcDeps } from './deps'

/** Key/value settings plus the skill and secret libraries. */
export function registerSettingsHandlers({ db }: IpcDeps): void {
  ipcMain.handle('settings:get', (_, key: string) => db.getSetting(key) ?? null)

  ipcMain.handle('settings:set', (_, key: string, value: string) => {
    db.setSetting(key, value)
  })

  ipcMain.handle('settings:getAll', () => {
    // Mobile pairing keys are live credentials, not UI settings.
    return Object.fromEntries(
      Object.entries(db.getAllSettings()).filter(([k]) => !k.startsWith('mobile_init_code_'))
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
