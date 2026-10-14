/**
 * The contract every per-CLI config store implements, and the read-check-write
 * cycle they share.
 *
 * A store knows one CLI's file layout. It reads the files into a state object,
 * lists the MCP servers in that state, applies a mutation to it, and serializes
 * it back. `BaseCliMcpStore.apply` wraps that in the conflict check: the files
 * are re-read immediately before the write, and if their fingerprint differs
 * from what the caller last saw the write is refused with a conflict instead
 * of silently overwriting an external edit.
 */

import type { CliId, CliMcpApplyResult, McpServerDefinition } from '../../shared/cli-mcp-config'
import type { CliMcpFileOwner } from './portable-file-owner'
import { preserveJsonDocument, validatePortableJsonText } from './jsonc-edit'
import { readFileSnapshot, serializeJsonDocument, type JsonDocument } from './file-store'
import { combineFingerprints, hashContent, writeFileAtomic, type FileSnapshot } from './file-store'

export type CliMcpMutation =
  | { kind: 'upsert'; name: string; previousName?: string; definition: McpServerDefinition }
  | { kind: 'remove'; name: string }
  | { kind: 'setEnabled'; name: string; enabled: boolean }
  | { kind: 'setToolEnabled'; name: string; tool: string; enabled: boolean }

/** A server as read from disk: unmasked, with references in the unified `${VAR}` form. */
export interface LoadedServer {
  name: string
  definition: McpServerDefinition
  enabled: boolean
  disabledTools: string[]
  enabledToolsOnly?: string[]
  issues: string[]
}

export interface CliFileRole {
  path: string
  role: string
}

export interface CliLoadResult {
  files: FileSnapshot[]
  roles: CliFileRole[]
  fingerprint: string
  servers: LoadedServer[]
  error?: string
  notes: string[]
}

export interface CliStateBundle<TState> {
  files: FileSnapshot[]
  state: TState
  notes: string[]
}

export interface MutationOutcome {
  warnings: string[]
}

export interface CliMcpStore {
  readonly cli: CliId
  /** The files this store reads and writes, whether or not they exist. */
  describeFiles(): CliFileRole[]
  load(): CliLoadResult
  /**
   * Re-reads the files, refuses if they no longer match `expectedFingerprint`,
   * asks `build` for the mutation (so it can consult the fresh state), applies
   * it and writes. `build` may return `{ error }` to abort without writing.
   */
  apply(
    expectedFingerprint: string | undefined,
    build: (fresh: CliLoadResult) => CliMcpMutation | { error: string }
  ): CliMcpApplyResult
}

export abstract class BaseCliMcpStore<TState> implements CliMcpStore {
  constructor(protected readonly fileOwner?: CliMcpFileOwner) {}
  assertOwners(files: CliMcpFileOwner): void { if (files !== this.fileOwner) throw new Error('CLI_MCP_STORE_OWNER_LOST'); files.assertOwners(files.homeDir) }
  protected readSnapshot(path: string): FileSnapshot { return this.fileOwner ? this.fileOwner.readSnapshot(path) : readFileSnapshot(path) }
  protected parseJson(content: string): void { if (this.fileOwner) validatePortableJsonText(content) }
  protected jsonText(doc: JsonDocument): string { return this.fileOwner ? preserveJsonDocument(doc, doc.originalText ?? '') : serializeJsonDocument(doc) }

  abstract readonly cli: CliId

  abstract describeFiles(): CliFileRole[]
  protected abstract readState(): CliStateBundle<TState>
  protected abstract serversFrom(state: TState): LoadedServer[]
  protected abstract mutate(state: TState, mutation: CliMcpMutation): MutationOutcome
  /** The files to write back; a store may skip files it did not change. */
  protected abstract serialize(state: TState): Array<{ path: string; content: string }>

  load(): CliLoadResult {
    const roles = this.describeFiles()
    try {
      const bundle = this.readState()
      return {
        files: bundle.files,
        roles,
        fingerprint: this.fingerprintOf(bundle.state),
        servers: this.serversFrom(bundle.state),
        notes: bundle.notes
      }
    } catch (error) {
      // A parse failure still yields a fingerprint so the UI can detect a fix.
      const files = this.readFilesOnly()
      return {
        files,
        roles,
        fingerprint: combineFingerprints(files),
        servers: [],
        error: this.fileOwner ? 'The CLI configuration could not be read.' : error instanceof Error ? error.message : String(error),
        notes: []
      }
    }
  }

  apply(
    expectedFingerprint: string | undefined,
    build: (fresh: CliLoadResult) => CliMcpMutation | { error: string }
  ): CliMcpApplyResult {
    let bundle: CliStateBundle<TState>
    try {
      this.fileOwner?.preflight()
      bundle = this.readState()
    } catch (error) {
      return { cli: this.cli, ok: false, error: this.fileOwner ? 'The CLI configuration could not be read.' : `Cannot read ${this.cli} config: ${error instanceof Error ? error.message : String(error)}`, warnings: [] }
    }

    const fingerprint = this.fingerprintOf(bundle.state)
    if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprint) {
      return {
        cli: this.cli,
        ok: false,
        conflict: {
          cli: this.cli,
          paths: bundle.files.map((file) => file.path),
          expectedFingerprint,
          currentFingerprint: fingerprint
        },
        warnings: []
      }
    }

    const fresh: CliLoadResult = {
      files: bundle.files,
      roles: this.describeFiles(),
      fingerprint,
      servers: this.serversFrom(bundle.state),
      notes: bundle.notes
    }
    let mutation: CliMcpMutation | { error: string }
    try { mutation = build(fresh) }
    catch (error) {
      if (!this.fileOwner) throw error
      this.fileOwner.current()
      return { cli: this.cli, ok: false, error: 'The saved value cannot be safely retained for this change.', warnings: [] }
    }
    if ('error' in mutation) return { cli: this.cli, ok: false, error: mutation.error, warnings: [] }

    try {
      const outcome = this.mutate(bundle.state, mutation)
      const before = new Map(bundle.files.map((file) => [file.path, file.content]))
      for (const { path, content } of this.serialize(bundle.state)) {
        if (before.get(path) === content) continue
        if (this.fileOwner) {
          const original = bundle.files.find(file => file.path === path)
          if (!original) throw new Error('CLI_MCP_FILE_INVALID')
          this.fileOwner.writeAtomic(path, content, original)
        } else writeFileAtomic(path, content)
      }
      return { cli: this.cli, ok: true, warnings: [...bundle.notes, ...outcome.warnings] }
    } catch (error) {
      return { cli: this.cli, ok: false, error: this.fileOwner ? 'The CLI configuration change could not be published.' : error instanceof Error ? error.message : String(error), warnings: [] }
    }
  }

  protected abstract readFilesOnly(): FileSnapshot[]

  /**
   * Fingerprint of the MCP view only, not the whole files. `~/.claude.json`
   * and Codex's `config.toml` change on nearly every CLI run (startup counters,
   * project trust), and every write already patches a fresh read, so only an
   * edit to the servers or tool switches the UI shows counts as a conflict.
   */
  protected fingerprintOf(state: TState): string {
    return hashContent(JSON.stringify(this.serversFrom(state)))
  }
}

/** Case-sensitive lookup that tolerates a missing server. */
export function findServer(result: CliLoadResult, name: string): LoadedServer | undefined {
  return result.servers.find((server) => server.name === name)
}
