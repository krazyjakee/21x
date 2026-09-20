import { expect, it } from 'vitest'
import { LEGACY_CAPTAIN_TOOL } from '@shared/captain-compat'
import { toolCallLabel } from './tool-call-label'

it('labels legacy delegation calls as Captain, including calls without project arguments', () => {
  expect(toolCallLabel(LEGACY_CAPTAIN_TOOL, undefined)).toBe('Ask captain')
  expect(toolCallLabel(LEGACY_CAPTAIN_TOOL, { project: 'Daccord', message: 'Status?' })).toBe('Asked Daccord: Status?')
  expect(toolCallLabel('ask_captain', { project: 'Daccord' })).toBe('Asked Daccord…')
  expect(toolCallLabel('get_task', undefined)).toBe('Get task')
})
