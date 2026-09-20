import { History } from 'lucide-react'
import { useMemo } from 'react'
import { useCommanderStore } from '@/stores/commander-store'
import { ActionCard } from './ActionCard'
import { collectCommanderActions } from './commander-actions'

const EMPTY = []

/** Successful, validated Commander mutations for the open session, newest first. */
export function CommanderActionsPane() {
  const messages = useCommanderStore((state) =>
    state.selectedSessionId ? state.messages[state.selectedSessionId] : undefined
  ) ?? EMPTY
  const actions = useMemo(() => collectCommanderActions(messages).reverse(), [messages])

  if (actions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-56 text-muted-foreground">
          <History className="mx-auto mb-3 size-6" aria-hidden="true" />
          <p className="text-sm font-medium text-foreground">No recent actions</p>
          <p className="mt-1 text-xs leading-relaxed">Changes the Commander makes will appear here.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-3" aria-label="Commander actions">
      {actions.map((action) => <ActionCard key={action.call.id} item={action} />)}
    </div>
  )
}
