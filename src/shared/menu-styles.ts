// Shared classes for the hand-built `role="menu"` dropdowns on desktop and
// mobile, so every popup menu has the same width, radius and elevation.
// (Radix-driven menus use the ui/* components instead.)

export const MENU_PANEL_CLASS =
  'absolute top-7 z-50 w-48 overflow-hidden rounded-lg border border-border/50 bg-popover p-1 shadow-xl'

export const MENU_ITEM_CLASS =
  'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs text-foreground transition-colors'
