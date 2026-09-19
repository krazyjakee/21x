import { MessageSquare, ListPlus } from 'lucide-react'

interface QuickChip {
  label: string
  type: 'captain' | 'task'
}

const CHIPS: QuickChip[] = [
  // Ask -> Captain
  { label: 'Summarize this week', type: 'captain' },
  { label: 'What needs my attention', type: 'captain' },
  { label: 'Pipeline status', type: 'captain' },
  { label: 'Overdue payments', type: 'captain' },
  // Task -> modal
  { label: 'Draft outreach email', type: 'task' },
  { label: 'Process invoices', type: 'task' },
  { label: 'Run reconciliation', type: 'task' },
  { label: 'Run a workflow', type: 'task' }
]

interface QuickChipsProps {
  onAskCaptain: (text: string) => void
  onCreateTask: (text: string) => void
}

export function QuickChips({ onAskCaptain, onCreateTask }: QuickChipsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {CHIPS.map((chip) => {
        const isCaptain = chip.type === 'captain'
        return (
          <button
            key={chip.label}
            onClick={() => {
              if (isCaptain) {
                onAskCaptain(chip.label)
              } else {
                onCreateTask(chip.label)
              }
            }}
            className="group flex items-center gap-2 px-3.5 py-1.5 rounded-full text-sm text-foreground/70 border border-border bg-card/50 hover:border-border hover:text-foreground hover:bg-card transition-colors duration-150 cursor-pointer"
          >
            {isCaptain ? (
              <MessageSquare className="size-icon-sm opacity-70 group-hover:opacity-100 transition-opacity" />
            ) : (
              <ListPlus className="size-icon-sm opacity-70 group-hover:opacity-100 transition-opacity" />
            )}
            {chip.label}
          </button>
        )
      })}
    </div>
  )
}
