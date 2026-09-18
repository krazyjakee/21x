import { AppLayout } from '@/components/layout/AppLayout'
import { useEffect } from 'react'
import { identifyAnalyticsUser, resetAnalyticsUser } from '@/lib/analytics'
import { useUserStore } from '@/stores/user-store'

export default function App() {
  const currentUserEmail = useUserStore((s) => s.currentUserEmail)

  useEffect(() => {
    if (currentUserEmail) {
      identifyAnalyticsUser(currentUserEmail, { email: currentUserEmail })
    } else {
      resetAnalyticsUser()
    }
  }, [currentUserEmail])

  return <AppLayout />
}
