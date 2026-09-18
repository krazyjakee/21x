import { settingsApi } from '@/lib/ipc-client'
import { DEFAULT_PROJECT_ID } from '@shared/projects'

/**
 * Settings that used to be one global blob (the canvas, the drawings) and are
 * now kept once per project. The key is `<base>:<projectId>`, so nothing in
 * the schema changes and a project that was never opened simply has no row.
 */
export function projectScopedKey(base: string, projectId: string): string {
  return `${base}:${projectId}`
}

/** The marker written once the old global key has been copied into Default. */
export function migrationMarkerKey(base: string): string {
  return `${base}_migrated_to_projects`
}

/**
 * Moves the pre-project global value into the Default project, once.
 *
 * Idempotent: the marker is written after the copy and checked first, so a
 * later run (another load, another launch) never copies again — even if the
 * user has since cleared the Default project's canvas. The old key is left in
 * place; there is no settings delete over IPC and a stale row costs nothing.
 */
export async function migrateLegacySettingToDefaultProject(base: string): Promise<void> {
  const marker = migrationMarkerKey(base)
  if (await settingsApi.get(marker)) return

  const legacy = await settingsApi.get(base)
  const target = projectScopedKey(base, DEFAULT_PROJECT_ID)
  if (legacy && !(await settingsApi.get(target))) {
    await settingsApi.set(target, legacy)
  }
  await settingsApi.set(marker, '1')
}
