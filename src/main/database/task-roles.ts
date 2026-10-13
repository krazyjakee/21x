import { HIDDEN_USER_TASK_ROLES } from '../../shared/task-roles'

/**
 * SQL predicate that keeps only rows the user may see as tasks.
 *
 * Every user task list, search and statistic must carry it. Captain rows host
 * conversations; task_group rows host counted shared execution. Neither is an
 * ordinary task card. Admission uses coordinator identity separately, so
 * hiding a group anchor never grants an exemption. `DatabaseManager.getTasks`
 * applies it for every consumer; the raw-SQL routes in task-api add it by hand.
 *
 * @param column - Qualified column when the query aliases `tasks` (e.g. `t.role`).
 */
export function userTaskRoleFilter(column = 'role'): string {
  return `${column} NOT IN (${HIDDEN_USER_TASK_ROLES.map((role) => `'${role}'`).join(', ')})`
}
