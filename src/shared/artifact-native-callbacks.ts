import type { ArtifactCopyFileResult } from './artifacts'
import { isDatabaseId } from './database-desktop-codecs'
import { isArtifactRelativePath } from './artifact-codecs'
import { isUiLeaseId } from './ui-desktop-codecs'
import { hasExactKeys, isRecord } from './service-protocol'
import { isWorkspacePathReceipt, type WorkspacePathReceipt } from './workspace-native-callbacks'

export const isArtifactClipboardReceipt = (value: unknown): value is WorkspacePathReceipt => isWorkspacePathReceipt(value) && value.target.kind === 'file' && value.target.nlink === '1' && BigInt(value.target.size) <= 64n * 1024n * 1024n
export const isArtifactClipboardResult = (value: unknown): value is ArtifactCopyFileResult => isRecord(value) && hasExactKeys(value, ['mode']) && (value.mode === 'file' || value.mode === 'unavailable')
export const isPrivateArtifactCopy = (value: unknown): value is { taskId: string; relativePath: string; leaseId: string } => isRecord(value) && hasExactKeys(value, ['taskId', 'relativePath', 'leaseId']) && isDatabaseId(value.taskId) && isArtifactRelativePath(value.relativePath) && isUiLeaseId(value.leaseId)
export const isPrivateArtifactCopyCheck = (value: unknown): value is { authorizationId: string } => isRecord(value) && hasExactKeys(value, ['authorizationId']) && typeof value.authorizationId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.authorizationId)
export const ARTIFACT_NATIVE_CALLBACK_SCHEMAS = {
  'host.artifact.copyFile': {
    validatePayload: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['receipt', 'leaseId', 'authorizationId']) && isArtifactClipboardReceipt(value.receipt) && isUiLeaseId(value.leaseId) && isPrivateArtifactCopyCheck({ authorizationId: value.authorizationId }),
    validateResult: isArtifactClipboardResult
  }
} as const
