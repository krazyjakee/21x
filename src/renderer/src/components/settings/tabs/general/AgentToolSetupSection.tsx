import { useState } from 'react'
import { Wrench } from 'lucide-react'
import { SettingsSection } from '../../SettingsSection'
import { Button } from '@/components/ui/Button'
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard'

export function AgentToolSetupSection() {
  const [setupDialogOpen, setSetupDialogOpen] = useState(false)

  return (
    <SettingsSection
      title="Agent & Tool Setup"
      description="Detect installed CLI tools and install missing ones"
    >
      <Button variant="outline" onClick={() => setSetupDialogOpen(true)}>
        <Wrench className="size-4 mr-1.5" />
        Open Setup Wizard
      </Button>
      <OnboardingWizard open={setupDialogOpen} onOpenChange={setSetupDialogOpen} />
    </SettingsSection>
  )
}
