import { rehydrateMcpDesktopState } from '@/stores/mcp-store'
import { rehydrateTaskSourceDesktopState } from '@/stores/task-source-store'
import { rehydrateTaskDesktopState } from '@/stores/task-store'
import { rehydrateProjectDesktopState } from '@/stores/project-store'
import { rehydrateSettingsDesktopState } from '@/stores/settings-store'
import { rehydrateDesktopAgentState } from '@/stores/agent-store'
import { rehydrateCommanderDesktopState } from '@/stores/commander-store'
import { rehydrateOverviewDesktopState } from '@/stores/overview-store'
import { rehydrateTaskGroupDesktopState } from '@/stores/task-group-store'
import { rehydrateSkillDesktopState } from '@/stores/skill-store'
import { rehydrateSecretDesktopState } from '@/stores/secret-store'

/** Read-only recovery. A failed owner leaves native mutation/approval fenced. */
export async function rehydrateProductionDesktop(): Promise<void> {
  await Promise.all([rehydrateTaskDesktopState(), rehydrateProjectDesktopState(), rehydrateSettingsDesktopState(), rehydrateDesktopAgentState(), rehydrateCommanderDesktopState(), rehydrateOverviewDesktopState(), rehydrateTaskGroupDesktopState(), rehydrateSkillDesktopState(), rehydrateSecretDesktopState(), rehydrateMcpDesktopState(), rehydrateTaskSourceDesktopState()])
}
