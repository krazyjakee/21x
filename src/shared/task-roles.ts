/**
 * What a row in `tasks` is for.
 *
 * Most rows are the user's work. A coordinator row is the durable home of an
 * agent conversation that is not itself a task: a project's Captain, or one
 * Commander chat session. It exists so that conversation has a session_id to
 * resume from and a transcript to hydrate, exactly like a task, without ever
 * being listed as one.
 */
export type TaskRole = 'task' | 'captain' | 'commander'

export const TASK_ROLE_TASK: TaskRole = 'task'
export const TASK_ROLE_CAPTAIN: TaskRole = 'captain'
/** One Commander chat session (docs/commander.md). The row id is the session id. */
export const TASK_ROLE_COMMANDER: TaskRole = 'commander'

/** Roles that are never shown to the user as tasks. */
export const COORDINATOR_ROLES: readonly TaskRole[] = [TASK_ROLE_CAPTAIN, TASK_ROLE_COMMANDER]

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

/** True for the row behind a Commander chat session. */
export function isCommanderTask(task: { role?: string | null } | null | undefined): boolean {
  return task?.role === TASK_ROLE_COMMANDER
}

/** True for a project's Captain row. */
export function isCaptainTask(task: { role?: string | null } | null | undefined): boolean {
  return task?.role === TASK_ROLE_CAPTAIN
}
