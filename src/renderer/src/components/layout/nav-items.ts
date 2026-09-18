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
