import type { DatabaseManager } from '../database'
import { ArtifactType } from '../../shared/artifacts'
import {
  createRegisteredTaskArtifact,
  editRegisteredTaskArtifactFile,
  listRegisteredTaskArtifacts,
  readRegisteredTaskArtifactFile,
  writeRegisteredTaskArtifactFile
} from '../artifacts'
import { existingTaskId, notifyRenderer } from './state'

const ROUTES = new Set(['/create_artifact', '/list_artifacts', '/write_artifact_file', '/edit_artifact_file', '/read_artifact_file'])

export async function handleArtifactRoute(db: DatabaseManager, route: string, params: Record<string, unknown>): Promise<unknown> {
  if (!ROUTES.has(route)) return undefined
  const taskId = existingTaskId(db, params)
  if (!taskId) return { error: 'Task not found' }
  const workspaceDir = db.getWorkspaceDir(taskId)

  switch (route) {
    case '/create_artifact': {
      const title = typeof params.title === 'string' ? params.title : ''
      const type = typeof params.type === 'string' ? params.type as ArtifactType : ArtifactType.FILE
      if (!title.trim()) return { error: 'Artifact title is required' }
      if (!Object.values(ArtifactType).includes(type) || type === ArtifactType.PR) return { error: 'Unsupported artifact type' }
      return { artifact: await createRegisteredTaskArtifact(workspaceDir, taskId, { title, type }) }
    }

    case '/list_artifacts':
      return listRegisteredTaskArtifacts(workspaceDir, taskId)

    case '/write_artifact_file': {
      if (typeof params.artifact_id !== 'string' || typeof params.filename !== 'string' || typeof params.content !== 'string') {
        return { error: 'artifact_id, filename, and content are required' }
      }
      const artifact = await writeRegisteredTaskArtifactFile(workspaceDir, taskId, {
        artifactId: params.artifact_id,
        filename: params.filename,
        content: params.content,
        encoding: params.encoding === 'base64' ? 'base64' : 'utf8',
        preview: params.preview === true
      })
      notifyRenderer?.('artifact:updated', { taskId, artifact })
      return { artifact }
    }

    case '/edit_artifact_file': {
      if (
        typeof params.artifact_id !== 'string'
        || typeof params.filename !== 'string'
        || typeof params.text_to_replace !== 'string'
        || typeof params.replacement !== 'string'
      ) return { error: 'artifact_id, filename, text_to_replace, and replacement are required' }
      const artifact = await editRegisteredTaskArtifactFile(workspaceDir, taskId, {
        artifactId: params.artifact_id,
        filename: params.filename,
        textToReplace: params.text_to_replace,
        replacement: params.replacement
      })
      notifyRenderer?.('artifact:updated', { taskId, artifact })
      return { artifact }
    }

    default: {
      if (typeof params.artifact_id !== 'string' || typeof params.filename !== 'string') {
        return { error: 'artifact_id and filename are required' }
      }
      return readRegisteredTaskArtifactFile(workspaceDir, taskId, params.artifact_id, params.filename)
    }
  }
}
