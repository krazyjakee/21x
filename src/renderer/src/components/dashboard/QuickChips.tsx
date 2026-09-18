import { MessageSquare, ListPlus } from 'lucide-react'

interface QuickChip {
  label: string
  type: 'mastermind' | 'task'
}

const CHIPS: QuickChip[] = [
  // Ask -> Mastermind
  { label: 'Summarize this week', type: 'mastermind' },
  { label: 'What needs my attention', type: 'mastermind' },
  { label: 'Pipeline status', type: 'mastermind' },
  { label: 'Overdue payments', type: 'mastermind' },
  // Task -> modal
  { label: 'Draft outreach email', type: 'task' },
  { label: 'Process invoices', type: 'task' },
  { label: 'Run reconciliation', type: 'task' },
  { label: 'Run a workflow', type: 'task' }
]

interface QuickChipsProps {
  onAskMastermind: (text: string) => void
  onCreateTask: (text: string) => void
}

export function QuickChips({ onAskMastermind, onCreateTask }: QuickChipsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {CHIPS.map((chip) => {
        const isMastermind = chip.type === 'mastermind'
        return (
          <button
            key={chip.label}
            onClick={() => {
              if (isMastermind) {
                onAskMastermind(chip.label)
              } else {
                onCreateTask(chip.label)
              }
            }}
            className="group flex items-center gap-2 px-3.5 py-1.5 rounded-full text-sm text-foreground/70 border border-border bg-card/50 hover:border-border hover:text-foreground hover:bg-card transition-colors duration-150 cursor-pointer"
          >
            {isMastermind ? (
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
