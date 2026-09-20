import { LayoutDashboard, CheckSquare, Zap, Layers, MessagesSquare, LayoutGrid } from 'lucide-react'
import type { SidebarView } from '@/stores/ui-store'

export const NAV_ITEMS: { key: SidebarView; label: string; icon: typeof LayoutDashboard }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'canvas', label: 'Canvas', icon: Layers },
  { key: 'tasks', label: 'Tasks', icon: CheckSquare },
  { key: 'skills', label: 'Skills', icon: Zap },
  { key: 'commander', label: 'Commander', icon: MessagesSquare },
  { key: 'overview', label: 'Projects', icon: LayoutGrid }
]

/**
 * Mod+<digit> for a main view: its 1-based position in NAV_ITEMS, so Mod+1–4
 * stay Dashboard, Canvas, Tasks, Skills and Mod+5 is Commander. Keep the order.
 */
export function navShortcutDigit(key: SidebarView): number | null {
  const index = NAV_ITEMS.findIndex((item) => item.key === key)
  return index < 0 ? null : index + 1
}
