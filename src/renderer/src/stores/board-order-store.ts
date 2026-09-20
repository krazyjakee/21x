import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { boardColumnKey } from '@/lib/board-order'

interface BoardOrderState {
  /** Presence means manually ordered, including an empty column. Not subtask sort_order. */
  orders: Record<string, string[]>
  /** Integration point for in-column drag ordering (PR #124 currently only changes status). */
  setColumnOrder: (projectId: string, status: string, orderedIds: string[]) => void
  resetColumnOrder: (projectId: string, status: string) => void
}

export const useBoardOrderStore = create<BoardOrderState>()(persist((set) => ({
  orders: {},
  setColumnOrder: (projectId, status, orderedIds) => set((state) => ({
    orders: { ...state.orders, [boardColumnKey(projectId, status)]: [...new Set(orderedIds)] }
  })),
  resetColumnOrder: (projectId, status) => set((state) => {
    const orders = { ...state.orders }
    delete orders[boardColumnKey(projectId, status)]
    return { orders }
  })
}), { name: 'board-column-orders', partialize: (state) => ({ orders: state.orders }) }))
