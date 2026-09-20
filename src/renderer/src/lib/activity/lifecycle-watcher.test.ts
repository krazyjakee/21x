import { describe, expect, it } from 'vitest'
import { diffLifecycleCompletions } from './lifecycle-watcher'

describe('diffLifecycleCompletions', () => {
  it('reports an observed transition into review', () => {
    const out = diffLifecycleCompletions(
      [{ id: 't', status: 'agent_working', title: 'T' }],
      [{ id: 't', status: 'ready_for_review', title: 'T' }],
      42
    )
    expect(out).toEqual([{ taskId: 't', title: 'T', to: 'ready_for_review', from: 'agent_working', at: 42, parentTaskId: null }])
  })

  it('never reports hydration, new rows or unchanged rows', () => {
    expect(diffLifecycleCompletions([], [{ id: 't', status: 'ready_for_review' }], 1)).toEqual([])
    expect(diffLifecycleCompletions([{ id: 'a', status: 'not_started' }], [{ id: 'b', status: 'completed' }], 1)).toEqual([])
    expect(diffLifecycleCompletions([{ id: 't', status: 'completed' }], [{ id: 't', status: 'completed' }], 1)).toEqual([])
  })

  it('ignores the user moving a reviewed task to completed', () => {
    expect(diffLifecycleCompletions([{ id: 't', status: 'ready_for_review' }], [{ id: 't', status: 'completed' }], 1)).toEqual([])
  })
})
