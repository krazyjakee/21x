import { COORDINATOR_ROLES } from '../../shared/task-roles'

/**
 * SQL predicate that keeps only rows the user may see as tasks.
 *
 * Every list, search and statistic over `tasks` must carry it — a coordinator
 * row is a conversation, not work, and showing it on the board (or counting it,
 * or matching it in find_similar_tasks) would be a bug. `DatabaseManager.getTasks`
 * applies it for every consumer; the raw-SQL routes in task-api add it by hand.
 *
 * @param column - Qualified column when the query aliases `tasks` (e.g. `t.role`).
 */
export function userTaskRoleFilter(column = 'role'): string {
  return `${column} NOT IN (${COORDINATOR_ROLES.map((role) => `'${role}'`).join(', ')})`
}
