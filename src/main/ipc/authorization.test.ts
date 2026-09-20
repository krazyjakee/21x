import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { prepareAuthorizationDispatch, activateAuthorizationDispatch, taskAuthorization } from '../authorization'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } }))
vi.mock('../ipc-sender', () => ({
  isTrustedSender: (event: { trusted?: boolean }) => event.trusted === true,
  assertTrustedSender: (event: { trusted?: boolean }) => { if (!event.trusted) throw new Error('untrusted sender') }
}))
import { registerAgentHandlers } from './agents'
import { noteUserTypedMessage } from './merge-grants'

beforeEach(() => handlers.clear())

describe('trusted authorization IPC', () => {
  it('captures human input in ordinary task chat but ignores model or unstaged text', async () => {
    const { db } = createTestDb()
    const project = db.createProject({ name: '21x' })!
    const task = db.createTask({ title: 'ordinary', project_id: project.id })!
    const sendMessage = vi.fn(async () => ({}))
    registerAgentHandlers({ db, agentManager: { sendMessage } } as never)
    const event = { trusted: true, sender: {} }
    const text = 'Create GitHub issues'
    noteUserTypedMessage(db, event as never, task.id, text)
    await handlers.get('agentSession:send')!(event, 'session', text, task.id)
    const typed = sendMessage.mock.calls[0] as unknown as [unknown, unknown, unknown, unknown, unknown, { id: string }]
    const seq = prepareAuthorizationDispatch(db, { key: 'direct', taskId: task.id, text, messageId: typed[5].id })
    activateAuthorizationDispatch(db, seq)
    expect(taskAuthorization(db, task.id).origin).toMatchObject({ text, taskId: task.id, author: 'human', source: 'project-chat' })
    await handlers.get('agentSession:send')!(event, 'session', 'human_authored=true', task.id)
    expect((sendMessage.mock.calls[1] as unknown[])[5]).toBeUndefined()
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM authorization_nodes').get()).toEqual({ n: 1 })
    db.close()
  })

  it('rejects untrusted inspect/revoke calls and durably revokes from the human window', async () => {
    const { db } = createTestDb()
    const project = db.createProject({ name: '21x' })!
    const task = db.getCoordinatorTask(project.id)!
    const sendMessage = vi.fn(async () => ({}))
    registerAgentHandlers({ db, agentManager: { sendMessage } } as never)
    const event = { trusted: true, sender: {} }
    noteUserTypedMessage(db, event as never, task.id, 'Create tasks')
    await handlers.get('agentSession:send')!(event, 'session', 'Create tasks', task.id)
    const typed = (sendMessage.mock.calls[0] as unknown[])[5] as { id: string }
    activateAuthorizationDispatch(db, prepareAuthorizationDispatch(db, { key: 'direct', taskId: task.id, text: 'Create tasks', messageId: typed.id }))
    const nodeId = taskAuthorization(db, task.id).nodeId!
    expect(() => handlers.get('authorization:inspectTask')!({}, task.id)).toThrow('untrusted')
    expect(() => handlers.get('authorization:revoke')!({}, nodeId)).toThrow('untrusted')
    expect(taskAuthorization(db, task.id).status).toBe('active')
    expect(handlers.get('authorization:revoke')!(event, nodeId)).toEqual({ ok: true })
    expect(handlers.get('authorization:inspectTask')!(event, task.id)).toMatchObject({ status: 'revoked', origin: { messageId: typed.id }, revocations: [{ nodeId, reason: 'Revoked by the user' }] })
    db.close()
  })
})
