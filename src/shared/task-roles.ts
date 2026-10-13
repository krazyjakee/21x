/**
 * What a row in `tasks` is for.
 *
 * Most rows are the user's work. A coordinator row is the durable home of an
 * agent conversation that is not itself a task — the Captain. It exists so
 * that conversation has a session_id to resume from and a transcript to
 * hydrate, exactly like a task, without ever being listed as one.
 * A task_group row is also hidden, but hosts ordinary counted work shared by
 * its members. Hidden presentation and coordinator admission are separate.
 */
export type TaskRole = 'task' | 'captain' | 'task_group'

export const TASK_ROLE_TASK: TaskRole = 'task'
export const TASK_ROLE_CAPTAIN: TaskRole = 'captain'
export const TASK_ROLE_TASK_GROUP: TaskRole = 'task_group'

/** Roles that are never shown to the user as tasks. */
export const COORDINATOR_ROLES: readonly TaskRole[] = [TASK_ROLE_CAPTAIN]
/** Hidden execution rows include counted work as well as conversations. */
export const HIDDEN_USER_TASK_ROLES: readonly TaskRole[] = [TASK_ROLE_CAPTAIN, TASK_ROLE_TASK_GROUP]

export function isHiddenUserTaskRole(role: string | null | undefined): boolean {
  return !!role && (HIDDEN_USER_TASK_ROLES as readonly string[]).includes(role)
}

export function isTaskGroupTask(task: { role?: string | null } | null | undefined): boolean {
  return task?.role === TASK_ROLE_TASK_GROUP
}

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
