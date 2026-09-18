import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { settingsApi } from '@/lib/ipc-client'
import type {
  DrawingObject,
  DrawingTool,
  DrawingToolOptions,
} from '@/components/canvas/drawing/types'
import { DEFAULT_STROKE, DEFAULT_TOOL_OPTIONS } from '@/components/canvas/drawing/types'
import { useThemeStore } from '@/stores/theme-store'
import { migrateLegacySettingToDefaultProject, projectScopedKey } from '@/lib/project-scoped-setting'
import { getCurrentProjectId, useProjectStore } from '@/stores/project-store'
import { DEFAULT_PROJECT_ID } from '@shared/projects'

/**
 * Drawings are kept once per project under `drawing_state:<projectId>`. The
 * bare key is the pre-project blob, copied into Default on first load.
 */
export const DRAWING_STORAGE_KEY = 'drawing_state'
export function drawingStorageKey(projectId: string): string {
  return projectScopedKey(DRAWING_STORAGE_KEY, projectId)
}

const SAVE_DEBOUNCE_MS = 1000
let saveTimer: ReturnType<typeof setTimeout> | null = null
/** Bumped per load so a slow load for the project left behind is dropped. */
let loadSeq = 0
/** The load under way, so a second request for the same project joins it. */
let inflightLoad: { projectId: string; promise: Promise<void> } | null = null

/**
 * Distributive Omit — `Omit` over a union only keeps the *common* keys, which
 * would drop the `type` discriminant and every type-specific field. This
 * distributes over the union so each figure variant keeps its own shape.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Distributive Partial — `Partial` over a union keeps only common keys; this
 *  distributes so each figure variant gets its own optional-fields shape. */
export type DistributivePartial<T> = T extends unknown ? Partial<T> : never

/** A full figure minus its identity/z-order — what `addObject` receives. */
export type NewFigure = DistributiveOmit<DrawingObject, 'id' | 'zIndex'>

/** A partial update of a figure (never `id` or `type`). */
export type FigureUpdates = DistributivePartial<DistributiveOmit<DrawingObject, 'id' | 'type'>>

// ── Persistence shape ─────────────────────────────────────

interface DrawingPersistedState {
  objects: DrawingObject[]
  nextZIndex: number
}

interface DrawingState {
  // ── persisted ──
  objects: DrawingObject[]
  nextZIndex: number
  /** The project these drawings belong to — set as a load starts, before it lands. */
  projectId: string
  /** True once `projectId`'s drawings have been read from settings. */
  isLoaded: boolean

  // ── transient: active tool + style ──
  activeTool: DrawingTool
  toolOptions: DrawingToolOptions

  // ── transient: interaction ──
  selectedIds: string[]
  /** Text figure currently in contentEditable mode. */
  editingTextId: string | null
  /** Figure being created (drag preview). */
  liveObject: DrawingObject | null

  // ── actions ──
  /**
   * Loads a project's drawings (the current project when none is named). Any
   * save still pending for the project left behind is written first, under
   * that project's key.
   */
  loadDrawings: (projectId?: string) => Promise<void>
  setTool: (tool: DrawingTool) => void
  setToolOption: <K extends keyof DrawingToolOptions>(key: K, value: DrawingToolOptions[K]) => void
  addObject: (obj: NewFigure) => string
  updateObject: (id: string, updates: FigureUpdates) => void
  removeObjects: (ids: string[]) => void
  bringToFront: (id: string) => void
  duplicateObject: (id: string) => void
  select: (ids: string[]) => void
  clearSelection: () => void
  setEditingTextId: (id: string | null) => void
  setLiveObject: (obj: DrawingObject | null) => void
}

let figureCounter = 0

/**
 * Writes the drawings under `projectId`'s key — unless the store has moved on.
 * The id is captured when the save is scheduled, so a save meant for project A
 * never lands under project B after a switch, and nothing is written while a
 * project's drawings are still being read.
 */
function persistNow(projectId: string): void {
  const state = useDrawingStore.getState()
  if (state.projectId !== projectId || !state.isLoaded) return
  const data: DrawingPersistedState = { objects: state.objects, nextZIndex: state.nextZIndex }
  settingsApi.set(drawingStorageKey(projectId), JSON.stringify(data)).catch((err) => {
    console.error('[Drawing] Failed to persist state:', err)
  })
}

/** Debounced persist of drawing state to the SQLite settings table. */
function scheduleSave() {
  const { projectId } = useDrawingStore.getState()
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistNow(projectId)
  }, SAVE_DEBOUNCE_MS)
}

/** Writes a pending save now, before the state it describes is replaced. */
function flushSave(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  persistNow(useDrawingStore.getState().projectId)
}

/**
 * Structural equality for the live creation preview. The gesture allocates a
 * fresh object every frame; an unconditional write would re-render the preview
 * (and any liveObject subscriber) on every frame even when nothing moved.
 */
function liveObjectEqual(a: DrawingObject | null, b: DrawingObject | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const aKeys = Object.keys(a) as Array<keyof DrawingObject>
  const bKeys = Object.keys(b) as Array<keyof DrawingObject>
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

export const useDrawingStore = create<DrawingState>()(subscribeWithSelector((set, get) => ({
  objects: [],
  nextZIndex: 1,
  projectId: DEFAULT_PROJECT_ID,
  isLoaded: false,
  activeTool: 'select',
  // Default stroke follows the current theme so new figures are visible on
  // the canvas (see DEFAULT_STROKE).
  toolOptions: { ...DEFAULT_TOOL_OPTIONS, stroke: DEFAULT_STROKE[useThemeStore.getState().resolved] },
  selectedIds: [],
  editingTextId: null,
  liveObject: null,

  loadDrawings: async (projectId = getCurrentProjectId()) => {
    if (inflightLoad?.projectId === projectId) return inflightLoad.promise
    const seq = ++loadSeq

    // The project left behind keeps what it had: write its pending save under
    // its own key before the state is replaced. The tool and style stay —
    // they belong to the user, not to a project.
    flushSave()
    set({
      projectId,
      isLoaded: false,
      objects: [],
      nextZIndex: 1,
      selectedIds: [],
      editingTextId: null,
      liveObject: null,
    })

    const promise = (async () => {
      try {
        await migrateLegacySettingToDefaultProject(DRAWING_STORAGE_KEY)
        const raw = await settingsApi.get(drawingStorageKey(projectId))
        // Another project was asked for while this one was being read.
        if (seq !== loadSeq) return
        if (!raw) {
          set({ isLoaded: true })
          return
        }
        const data = JSON.parse(raw) as DrawingPersistedState
        // Restore the ID counter from persisted figure IDs so new figures never
        // collide with loaded ones (same pattern as panels/edges in canvas-store).
        for (const o of data.objects) {
          const match = o.id.match(/^figure-(\d+)/)
          if (match) figureCounter = Math.max(figureCounter, parseInt(match[1], 10))
        }
        set({
          objects: data.objects,
          nextZIndex: data.nextZIndex,
          isLoaded: true,
        })
      } catch (err) {
        if (seq !== loadSeq) return
        console.error('[Drawing] Failed to load persisted state:', err)
        set({ isLoaded: true })
      } finally {
        if (inflightLoad?.projectId === projectId && seq === loadSeq) inflightLoad = null
      }
    })()
    inflightLoad = { projectId, promise }
    return promise
  },

  setTool: (tool) => {
    // Switching tools cancels any in-progress creation and exits text editing.
    set({ activeTool: tool, liveObject: null, editingTextId: null })
  },

  setToolOption: (key, value) => {
    set((s) => ({ toolOptions: { ...s.toolOptions, [key]: value } }))
  },

  addObject: (obj) => {
    const id = `figure-${++figureCounter}-${Date.now()}`
    const { nextZIndex } = get()
    set((s) => ({
      objects: [...s.objects, { ...obj, id, zIndex: nextZIndex } as DrawingObject],
      nextZIndex: nextZIndex + 1,
    }))
    scheduleSave()
    return id
  },

  updateObject: (id, updates) => {
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id ? ({ ...o, ...updates } as DrawingObject) : o
      ),
    }))
    scheduleSave()
  },

  removeObjects: (ids) => {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    set((s) => ({
      objects: s.objects.filter((o) => !idSet.has(o.id)),
      selectedIds: s.selectedIds.filter((sid) => !idSet.has(sid)),
      editingTextId: s.editingTextId && idSet.has(s.editingTextId) ? null : s.editingTextId,
    }))
    scheduleSave()
  },

  bringToFront: (id) => {
    const { nextZIndex } = get()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? { ...o, zIndex: nextZIndex } : o)),
      nextZIndex: nextZIndex + 1,
    }))
    scheduleSave()
  },

  duplicateObject: (id) => {
    const { objects, nextZIndex } = get()
    const source = objects.find((o) => o.id === id)
    if (!source) return
    const newId = `figure-${++figureCounter}-${Date.now()}`
    const copy: DrawingObject = {
      ...source,
      id: newId,
      x: source.x + 20,
      y: source.y + 20,
      zIndex: nextZIndex,
    }
    set((s) => ({
      objects: [...s.objects, copy],
      nextZIndex: nextZIndex + 1,
      selectedIds: [newId],
    }))
    scheduleSave()
  },

  select: (ids) => set({ selectedIds: ids }),
  clearSelection: () => set({ selectedIds: [] }),
  setEditingTextId: (id) => set({ editingTextId: id }),

  setLiveObject: (obj) => {
    if (liveObjectEqual(get().liveObject, obj)) return
    set({ liveObject: obj })
  },
})))

// Drawings follow the current project whether or not the canvas is on screen,
// so the figures never lag one project behind the panels.
useProjectStore.subscribe((state, previous) => {
  if (state.currentProjectId === previous.currentProjectId) return
  void useDrawingStore.getState().loadDrawings(state.currentProjectId)
})
