/** One runtime admission fence shared by bridge jobs, piece calls and OAuth.
 * Credential edits refuse outstanding work rather than treating a public
 * timeout as proof that its worker or credential callback has stopped. */
export class ConnectorCredentialMutationBusyError extends Error {
  readonly code = 'CONNECTOR_CREDENTIAL_MUTATION_BUSY'
  constructor() { super('Connector work must finish before credentials can change'); this.name = 'ConnectorCredentialMutationBusyError' }
}

export interface ConnectorCredentialMutationToken { readonly instanceId: string }

export class ConnectorCredentialAdmission {
  private readonly work = new Map<string, number>()
  private readonly mutations = new Set<ConnectorCredentialMutationToken>()

  enter(instanceId: string, token?: ConnectorCredentialMutationToken): () => void {
    const active = [...this.mutations].find(item => item.instanceId === instanceId)
    if (active && active !== token) throw new ConnectorCredentialMutationBusyError()
    if (token && (!this.mutations.has(token) || token.instanceId !== instanceId)) throw new ConnectorCredentialMutationBusyError()
    this.work.set(instanceId, (this.work.get(instanceId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.work.get(instanceId) ?? 1) - 1
      if (count) this.work.set(instanceId, count)
      else this.work.delete(instanceId)
    }
  }

  begin(instanceId: string): { token: ConnectorCredentialMutationToken; release(): void } {
    // Retiring workers are shared by every instance. Refuse their raw exit
    // ownership and conservatively refuse other accepted runtime jobs too.
    if (this.work.size || this.mutations.size) throw new ConnectorCredentialMutationBusyError()
    const token = Object.freeze({ instanceId })
    this.mutations.add(token)
    return { token, release: () => { this.mutations.delete(token) } }
  }
}
