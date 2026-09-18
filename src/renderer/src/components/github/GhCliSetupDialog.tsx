import { useState, useEffect, useCallback } from 'react'
import { CheckCircle, Loader2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { useSettingsStore } from '@/stores/settings-store'
import { GhCliGuidance } from './GhCliGuidance'

interface GhCliSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => void
}

/**
 * 20x never authenticates with GitHub itself — it relies on the gh CLI's
 * existing session. This dialog only reports status and tells the user which
 * command to run in their own terminal.
 */
export function GhCliSetupDialog({ open, onOpenChange, onComplete }: GhCliSetupDialogProps) {
  const { ghCliStatus, checkGhCli } = useSettingsStore()
  const [isChecking, setIsChecking] = useState(false)

  const recheck = useCallback(() => {
    setIsChecking(true)
    checkGhCli().catch(() => {}).finally(() => setIsChecking(false))
  }, [checkGhCli])

  useEffect(() => {
    if (open) recheck()
  }, [open])

  const isAuthenticated = ghCliStatus?.authenticated ?? false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>GitHub CLI</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {isChecking && !ghCliStatus ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : isAuthenticated ? (
            <>
              <p className="flex items-center gap-1.5 text-sm">
                <CheckCircle className="h-4 w-4 text-green-400" />
                Using gh CLI{ghCliStatus?.username ? ` as ${ghCliStatus.username}` : ''}
              </p>
              <Button className="w-full" onClick={onComplete}>Continue</Button>
            </>
          ) : (
            <>
              <GhCliGuidance status={ghCliStatus} />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={recheck} disabled={isChecking}>
                  {isChecking && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                  Re-check
                </Button>
                <a
                  href="https://cli.github.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  cli.github.com <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
