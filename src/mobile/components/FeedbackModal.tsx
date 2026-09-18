import { useState } from 'react'

export function FeedbackModal({ onSubmit, onSkip, onCancel, completionDescription, sourceName, withFeedback }: {
  completionDescription?: string
  sourceName?: string
  withFeedback: boolean
  onSubmit: (rating: number, comment: string, completeAtSource: boolean) => void
  onSkip: (completeAtSource: boolean) => void
  onCancel: () => void
}) {
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [completeAtSource, setCompleteAtSource] = useState(true)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div role="dialog" aria-label={withFeedback ? 'Session feedback' : 'Complete task'} className="mx-4 w-full max-w-md rounded-xl border bg-card p-5 space-y-4">
        <h2>{withFeedback ? 'Session feedback' : 'Complete task'}</h2>
        {sourceName && (
          <div className="rounded-md border p-3 text-sm space-y-2">
            <p>{completeAtSource ? completionDescription : 'Complete in 21x only. The source record will not change.'}</p>
            <div className="flex gap-2">
              <button className={`flex-1 rounded-md border px-2 py-2 ${completeAtSource ? 'border-ring bg-accent' : 'border-border text-muted-foreground'}`} role="radio" aria-checked={completeAtSource} onClick={() => setCompleteAtSource(true)}>Close it in {sourceName}</button>
              <button className={`flex-1 rounded-md border px-2 py-2 ${!completeAtSource ? 'border-ring bg-accent' : 'border-border text-muted-foreground'}`} role="radio" aria-checked={!completeAtSource} onClick={() => setCompleteAtSource(false)}>I'll do it manually</button>
            </div>
          </div>
        )}
        {withFeedback && <>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map(value => <button key={value} aria-label={`Rate ${value}`} aria-pressed={rating === value} onClick={() => setRating(value)}>{value}</button>)}
          </div>
          <textarea aria-label="Feedback" placeholder="Optional feedback..." value={comment} onChange={event => setComment(event.target.value)} />
        </>}
        <div className="flex gap-3">
          <button onClick={onCancel}>Cancel</button>
          <button onClick={() => onSkip(completeAtSource)}>{withFeedback ? 'Skip' : 'Complete'}</button>
          {withFeedback && <button disabled={!rating} onClick={() => onSubmit(rating, comment, completeAtSource)}>Submit Feedback</button>}
        </div>
      </div>
    </div>
  )
}
