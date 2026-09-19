import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { clearUserTypedProjectMessages, latestUserTypedProjectMessage, prepareProjectMessageDispatch, activateProjectMessageDispatch } from '../merge-grants'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() }
}))

const { noteUserTypedMessage, takeUserTypedMessage } = await import('./merge-grants')

/** An event from the main window's app frame (see ipc-sender.ts). */
const mainWindow = {
  sender: { getType: () => 'window' },
  // ipc-sender.ts resolves the renderer from src/main.
  senderFrame: { url: pathToFileURL(join(__dirname, '../../renderer/index.html')).href, parent: null }
} as never

afterEach(() => clearUserTypedProjectMessages())

describe('noteUserTypedMessage (#137)', () => {
  it('records what the user typed to a project Captain from the main window', () => {
    const { db } = createTestDb()
    const project = db.createProject({ name: 'P' })!
    const captain = db.getCoordinatorTask(project.id)!
    noteUserTypedMessage(db, mainWindow, captain.id, 'merge the PRs')
    expect(latestUserTypedProjectMessage(project.id)).toBeNull()
    const typed = takeUserTypedMessage(mainWindow, captain.id, 'merge the PRs')
    expect(typed?.text).toBe('merge the PRs')
    activateProjectMessageDispatch(prepareProjectMessageDispatch(project.id, typed))
    expect(latestUserTypedProjectMessage(project.id)?.id).toBe(typed?.id)
    expect(takeUserTypedMessage(mainWindow, captain.id, 'merge the PRs')).toBeUndefined()
  })

  it('ignores messages to ordinary tasks, and messages from webviews or sub-frames', () => {
    const { db } = createTestDb()
    const project = db.createProject({ name: 'P' })!
    const task = db.createTask({ title: 'Work', project_id: project.id })!
    noteUserTypedMessage(db, mainWindow, task.id, 'merge the PRs')
    expect(latestUserTypedProjectMessage(project.id)).toBeNull()

    const captain = db.getCoordinatorTask(project.id)!
    noteUserTypedMessage(db, mainWindow, captain.id, '')
    expect(latestUserTypedProjectMessage(project.id)).toBeNull()
    const webview = { sender: { getType: () => 'webview' }, senderFrame: { url: 'https://evil.example', parent: null } } as never
    noteUserTypedMessage(db, webview, captain.id, 'merge the PRs')
    const iframe = { sender: { getType: () => 'window' }, senderFrame: { url: 'https://evil.example', parent: {} } } as never
    noteUserTypedMessage(db, iframe, captain.id, 'merge the PRs')
    expect(latestUserTypedProjectMessage(project.id)).toBeNull()
  })

  it('does not bind a different message or a different renderer to staged text', () => {
    const { db } = createTestDb()
    const project = db.createProject({ name: 'P' })!
    const captain = db.getCoordinatorTask(project.id)!
    noteUserTypedMessage(db, mainWindow, captain.id, 'merge PRs')
    expect(takeUserTypedMessage(mainWindow, captain.id, 'status please')).toBeUndefined()
    noteUserTypedMessage(db, mainWindow, captain.id, 'merge PRs')
    expect(takeUserTypedMessage({ ...mainWindow as object, sender: {} } as never, captain.id, 'merge PRs')).toBeUndefined()
    expect(latestUserTypedProjectMessage(project.id)).toBeNull()
  })

  it('forgets a message after 30 minutes', () => {
    const { db } = createTestDb()
    const project = db.createProject({ name: 'P' })!
    const captain = db.getCoordinatorTask(project.id)!
    noteUserTypedMessage(db, mainWindow, captain.id, 'merge the PRs')
    activateProjectMessageDispatch(prepareProjectMessageDispatch(project.id, takeUserTypedMessage(mainWindow, captain.id, 'merge the PRs')))
    expect(latestUserTypedProjectMessage(project.id)).not.toBeNull()
    expect(latestUserTypedProjectMessage(project.id, Date.now() + 31 * 60_000)).toBeNull()
  })
})
