import { describe, expect, it } from 'vitest'
import { ConnectorCredentialAdmission, ConnectorCredentialMutationBusyError } from './credential-admission'

describe('connector credential mutation admission', () => {
  it('retains independently owned callbacks after a public call completes', () => {
    const guard = new ConnectorCredentialAdmission()
    const publicCall = guard.enter('instance')
    const callback = guard.enter('instance')
    publicCall()
    expect(() => guard.begin('instance')).toThrow(ConnectorCredentialMutationBusyError)
    callback()
    const edit = guard.begin('instance')
    expect(() => guard.enter('instance')).toThrow(ConnectorCredentialMutationBusyError)
    expect(() => guard.enter('instance', { instanceId: 'instance' })).toThrow(ConnectorCredentialMutationBusyError)
    const accepted = guard.enter('instance', edit.token)
    accepted()
    edit.release()
    guard.enter('instance')()
  })

  it('refuses outstanding unrelated work and retiring workers without cancelling them', () => {
    const guard = new ConnectorCredentialAdmission()
    const work = guard.enter('other')
    expect(() => guard.begin('instance')).toThrow(ConnectorCredentialMutationBusyError)
    work()
    const exit = guard.enter('__retiring_connector_worker__')
    expect(() => guard.begin('instance')).toThrow(ConnectorCredentialMutationBusyError)
    exit()
    const edit = guard.begin('instance')
    expect(() => guard.begin('other')).toThrow(ConnectorCredentialMutationBusyError)
    edit.release()
    expect(() => guard.enter('instance', edit.token)).toThrow(ConnectorCredentialMutationBusyError)
  })
})
