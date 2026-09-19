import { CronScheduleInput } from '@/components/settings/CronScheduleInput'
import { readScheduledReviewSettings, type ScheduledReviewSettings } from '@shared/scheduled-coordination'

interface ScheduledReviewSectionProps {
  /** The project draft's settings JSON. */
  settings: Record<string, unknown> | null | undefined
  /** Writes the review block into the draft; saved with the rest of the project. */
  onChange: (review: ScheduledReviewSettings) => void
}

/** Project editor → Scheduled review (#67): `settings.scheduled_review`, off by default. */
export function ScheduledReviewSection({ settings, onChange }: ScheduledReviewSectionProps) {
  const review = readScheduledReviewSettings(settings)
  return (
    <section className="space-y-3" aria-label="Scheduled review">
      <div>
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Scheduled review</h3>
        <p className="text-xs text-muted-foreground">
          Wakes this project’s Mastermind on a schedule to review the board, re-plan and update the project status. Runs with the window closed; skipped while the project is paused.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={review.enabled}
          onChange={(e) => onChange({ ...review, enabled: e.target.checked })}
          aria-label="Run a scheduled Mastermind review"
        />
        Run a scheduled Mastermind review
      </label>
      <div className={`pl-5 ${review.enabled ? '' : 'opacity-50'}`}>
        <CronScheduleInput
          id="project-scheduled-review-cron"
          value={review.cron}
          disabled={!review.enabled}
          onChange={(cron) => onChange({ ...review, cron })}
        />
      </div>
    </section>
  )
}
