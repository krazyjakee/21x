/**
 * What a row in `tasks` is for.
 *
 * Most rows are the user's work. A coordinator row is the durable home of an
 * agent conversation that is not itself a task — the Mastermind. It exists so
 * that conversation has a session_id to resume from and a transcript to
 * hydrate, exactly like a task, without ever being listed as one.
 */
export type TaskRole = 'task' | 'mastermind'

export const TASK_ROLE_TASK: TaskRole = 'task'
export const TASK_ROLE_MASTERMIND: TaskRole = 'mastermind'

/** Roles that are never shown to the user as tasks. */
export const COORDINATOR_ROLES: readonly TaskRole[] = [TASK_ROLE_MASTERMIND]

export function isCoordinatorRole(role: string | null | undefined): boolean {
  return !!role && (COORDINATOR_ROLES as readonly string[]).includes(role)
}

/**
 * True for a row that hosts a coordinator conversation. Takes anything with a
 * `role`, so both main-process records and renderer tasks can ask.
 */
export function isCoordinatorTask(task: { role?: string | null } | null | undefined): boolean {
  return isCoordinatorRole(task?.role)
}
