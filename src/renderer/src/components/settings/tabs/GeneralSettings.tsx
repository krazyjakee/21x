import { AppPreferencesSection } from './general/AppPreferencesSection'
import { ConnectPhoneSection } from './general/ConnectPhoneSection'
import { WorkspaceCleanupSection } from './general/WorkspaceCleanupSection'
import { HeartbeatSection } from './general/HeartbeatSection'
import { UpdatesSection } from './general/UpdatesSection'
import { AgentToolSetupSection } from './general/AgentToolSetupSection'

export function GeneralSettings() {
  return (
    <>
      <AppPreferencesSection />
      <ConnectPhoneSection />
      <WorkspaceCleanupSection />
      <HeartbeatSection />
      <UpdatesSection />
      <AgentToolSetupSection />
    </>
  )
}
