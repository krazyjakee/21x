import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableDbFixture as createTestDb } from '../../../../test/helpers/portable-db-test-helper'
import { closeConnectorRuntime, ConnectorRuntimeClosedError, disposeConnectorRuntime, getConnectorRuntime as resolveRuntime } from './runtime-core'
import { PieceHostShutdownIncompleteError } from '../piece-host/client'
import { PieceCancelledError } from '../piece-host/errors'

const host = {
  createTransport: () => { throw new Error('Lifetime controls must not start a worker') },
  openExternal: () => { throw new Error('Lifetime controls must not open a browser') }
}
const getConnectorRuntime = (source: Parameters<typeof resolveRuntime>[0]) => resolveRuntime(source, host)

describe('connector runtime ownership', () => {
  const sources: ReturnType<typeof createTestDb>[] = []
  function fixture() {
    const source = createTestDb()
    sources.push(source)
    return source
  }
  afterEach(async () => {
    for (const source of sources) {
      await closeConnectorRuntime(source.db)
      source.rawDb.close()
    }
    sources.length = 0
    vi.restoreAllMocks()
  })

  it('retains a cancelled credential read through disposal and a failed close without reviving the runtime', async () => {
    const source = fixture()
    const runtime = getConnectorRuntime(source.db)
    let finish!: (value: null) => void
    const credentials = new Promise<null>(done => { finish = done })
    const read = vi.spyOn(runtime.credentials, 'get').mockReturnValue(credentials)
    const result = expect(runtime.client.runAction({ instanceId: 'fixture', pieceName: '@activepieces/piece-trello',
      pieceVersion: '0.6.0', actionName: 'get_board' })).rejects.toBeInstanceOf(PieceCancelledError)
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
      disposeConnectorRuntime(source.db)
      await result
      expect(() => getConnectorRuntime(source.db)).toThrow(ConnectorRuntimeClosedError)
      await expect(closeConnectorRuntime(source.db, 5)).rejects.toBeInstanceOf(PieceHostShutdownIncompleteError)
      expect(source.rawDb.open).toBe(true)
      let closed = false
      const retry = closeConnectorRuntime(source.db).then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      finish(null)
      await retry
      expect(runtime.client.starts).toBe(0)
      expect(() => getConnectorRuntime(source.db)).toThrow(ConnectorRuntimeClosedError)
    } finally { finish(null); await result }
  })

  it('closes an unused source without allocating a worker or allowing later creation', async () => {
    const source = fixture()
    await closeConnectorRuntime(source.db)
    expect(() => getConnectorRuntime(source.db)).toThrow(ConnectorRuntimeClosedError)
    expect(source.rawDb.open).toBe(true)
  })

  it('validates the deadline before stopping an existing runtime', async () => {
    const source = fixture()
    const runtime = getConnectorRuntime(source.db)
    await expect(closeConnectorRuntime(source.db, 0)).rejects.toBeInstanceOf(RangeError)
    expect(getConnectorRuntime(source.db)).toBe(runtime)
    await closeConnectorRuntime(source.db)
    expect(runtime.client.starts).toBe(0)
  })
})
