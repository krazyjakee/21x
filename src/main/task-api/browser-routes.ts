/** Browser-panel tools; see panel-browser-broker.ts. */
import type { DatabaseManager } from '../database'
import { panelBrowserBroker } from '../panel-browser-broker'
import { existingTaskId, str } from './state'

const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)

/** Saved recordings stay readable after the browser panel closes. */
function handleRecordingRoute(taskId: string, route: string, params: Record<string, unknown>): unknown {
  const paged = route === '/browser_recording_list' || route === '/browser_recording_steps'
  const offset = params.offset === undefined ? 0 : params.offset
  const limit = params.limit === undefined ? 50 : params.limit
  if (paged && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)) {
    return { error: 'offset must be a non-negative safe integer' }
  }
  if (paged && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) {
    return { error: 'limit must be an integer between 1 and 100' }
  }
  const recordingId = params.recording_id
  const snapshotId = params.snapshot_id
  if (route !== '/browser_recording_list' && !validId(recordingId)) return { error: 'A valid recording_id is required' }
  if (route === '/browser_recording_snapshot' && !validId(snapshotId)) return { error: 'A valid snapshot_id is required' }
  try {
    const recordings = panelBrowserBroker.recordings
    if (route === '/browser_recording_list') {
      const all = recordings.list(taskId)
      const start = offset as number
      const end = start + (limit as number)
      return { recordings: all.slice(start, end), total: all.length, nextOffset: end < all.length ? end : null }
    }
    if (route === '/browser_recording_get') return { recording: recordings.get(taskId, recordingId as string) }
    if (route === '/browser_recording_steps') return recordings.steps(taskId, recordingId as string, offset as number, limit as number)
    return { snapshot: recordings.snapshot(taskId, recordingId as string, snapshotId as string) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not read the browser recording' }
  }
}

export async function handleBrowserRoute(db: DatabaseManager, route: string, params: Record<string, unknown>): Promise<unknown> {
  if (!route.startsWith('/browser_')) return undefined
  const taskId = existingTaskId(db, params)
  if (!taskId) return { error: 'Task not found' }
  const panelId = str(params.panel_id)

  switch (route) {
    case '/browser_recording_list':
    case '/browser_recording_get':
    case '/browser_recording_steps':
    case '/browser_recording_snapshot':
      return handleRecordingRoute(taskId, route, params)

    case '/browser_list_panels':
      return { panels: panelBrowserBroker.listPanels(taskId) }

    case '/browser_navigate':
      if (typeof params.url !== 'string' || !params.url.trim()) return { error: 'url is required' }
      return panelBrowserBroker.navigate(taskId, params.url, panelId)

    case '/browser_snapshot':
      return panelBrowserBroker.snapshot(taskId, panelId)

    case '/browser_click':
      if (typeof params.target !== 'string' || !params.target) return { error: 'target (@ref or CSS selector) is required' }
      return panelBrowserBroker.click(taskId, params.target, panelId)

    case '/browser_type':
      if (typeof params.target !== 'string' || !params.target) return { error: 'target (@ref or CSS selector) is required' }
      if (typeof params.text !== 'string') return { error: 'text is required' }
      return panelBrowserBroker.type(taskId, params.target, params.text, params.submit === true, panelId)

    case '/browser_press_key':
      if (typeof params.key !== 'string' || !params.key) return { error: 'key is required' }
      return panelBrowserBroker.pressKey(taskId, params.key, panelId)

    case '/browser_scroll':
      return panelBrowserBroker.scroll(
        taskId,
        typeof params.direction === 'string' ? params.direction : undefined,
        typeof params.amount === 'number' ? params.amount : undefined,
        typeof params.target === 'string' ? params.target : undefined,
        panelId
      )

    case '/browser_get': {
      const what = typeof params.what === 'string' ? params.what : ''
      if (what !== 'url' && what !== 'title' && what !== 'text') return { error: 'what must be url | title | text' }
      return panelBrowserBroker.get(taskId, what, panelId)
    }

    case '/browser_wait': {
      const mode = params.mode
      if (mode !== 'selector' && mode !== 'text' && mode !== 'url') return { error: 'mode must be selector | text | url' }
      if (typeof params.value !== 'string' || !params.value) return { error: 'value is required' }
      return panelBrowserBroker.wait(taskId, mode, params.value, typeof params.timeout_ms === 'number' ? params.timeout_ms : undefined, panelId)
    }

    case '/browser_screenshot':
      return panelBrowserBroker.screenshot(taskId, panelId)

    case '/browser_back':
      return panelBrowserBroker.back(taskId, panelId)

    case '/browser_forward':
      return panelBrowserBroker.forward(taskId, panelId)

    case '/browser_reload':
      return panelBrowserBroker.reload(taskId, panelId, params.hard === true)

    case '/browser_console': {
      const level = typeof params.level === 'string' ? params.level : undefined
      if (level && !['debug', 'info', 'warning', 'error'].includes(level.toLowerCase())) {
        return { error: 'level must be debug | info | warning | error' }
      }
      return panelBrowserBroker.console(
        taskId,
        { level, limit: typeof params.limit === 'number' ? params.limit : undefined, clear: params.clear === true },
        panelId
      )
    }

    case '/browser_network':
      return panelBrowserBroker.network(
        taskId,
        typeof params.filter === 'string' ? params.filter : undefined,
        typeof params.limit === 'number' ? params.limit : undefined,
        panelId
      )

    default:
      return { error: 'Unknown route' }
  }
}
