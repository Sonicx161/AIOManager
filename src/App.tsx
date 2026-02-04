import { AccountForm } from '@/components/accounts/AccountForm'
import { AddonInstaller } from '@/components/addons/AddonInstaller'
import { MasterPasswordSetup } from '@/components/auth/MasterPasswordSetup'
import { UnlockDialog } from '@/components/auth/UnlockDialog'
import { ExportDialog } from '@/components/ExportDialog'
import { ImportDialog } from '@/components/ImportDialog'
import { Layout } from '@/components/layout/Layout'
import { ScrollToTop } from '@/components/ScrollToTop'
import { Toaster } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useAuthStore } from '@/store/authStore'
import { useUIStore } from '@/store/uiStore'
import { useProfileStore } from '@/store/profileStore'
import { useFailoverStore } from '@/store/failoverStore'
import { useSyncStore } from '@/store/syncStore'
import { LoginPage } from '@/pages/LoginPage'
import { useEffect, useState } from 'react'

function App() {
  const initializeAccounts = useAccountStore((state) => state.initialize)
  const initializeAddons = useAddonStore((state) => state.initialize)
  const initializeAuth = useAuthStore((state) => state.initialize)
  const initializeUI = useUIStore((state) => state.initialize)
  const initializeProfiles = useProfileStore((state) => state.initialize)
  const initializeFailover = useFailoverStore((state) => state.initialize)
  const startFailoverAutomation = useFailoverStore((state) => state.startAutomation)
  const isLocked = useAuthStore((state) => state.isLocked)
  const isPasswordSet = useAuthStore((state) => state.isPasswordSet())
  const [isInitialized, setIsInitialized] = useState(false)

  const { auth, autoSyncEnabled, syncToRemote } = useSyncStore()

  useEffect(() => {
    initializeUI()
    initializeAuth()

    Promise.all([
      initializeAccounts(),
      initializeAddons(),
      initializeProfiles(),
      initializeFailover()
    ]).then(() => {
      startFailoverAutomation()
      setIsInitialized(true)
    })
  }, [initializeAccounts, initializeAddons, initializeAuth, initializeUI, initializeProfiles, initializeFailover, startFailoverAutomation])

  // Background Auto-Sync logic
  useEffect(() => {
    if (!auth.isAuthenticated || !autoSyncEnabled || !isInitialized) return

    // Periodic Push (every 2 minutes)
    const interval = setInterval(() => {
      // Idle Optimization: Skip auto-sync if tab is hidden
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      syncToRemote(true).catch(console.error)
    }, 2 * 60 * 1000)

    return () => clearInterval(interval)
  }, [auth.isAuthenticated, autoSyncEnabled, syncToRemote, isInitialized])

  // Sync UUID to URL for easy bookmarking/sharing
  useEffect(() => {
    if (auth.isAuthenticated && auth.id && isInitialized) {
      const url = new URL(window.location.href)
      if (url.searchParams.get('id') !== auth.id) {
        url.searchParams.set('id', auth.id)
        window.history.replaceState({}, '', url.toString())
      }
    }
  }, [auth.isAuthenticated, auth.id, isInitialized])

  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-2">Loading...</h2>
          <p className="text-muted-foreground">Initializing AIOManager</p>
        </div>
      </div>
    )
  }

  // Auth Guard
  if (!auth.isAuthenticated) {
    // Check for Deep Link (Parity with AIOStreams)
    // If user visits /account/<UUID> directly, we want to pre-fill that UUID
    const path = window.location.pathname
    const match = path.match(/^\/account\/([a-zA-Z0-9-]+)/)

    if (match && match[1]) {
      // Redirect to login with ID param
      // We use window.location to ensure a hard redirect/reset of query params
      const uuid = match[1]
      // Only redirect if we aren't already there (to prevent loop)
      const currentId = new URLSearchParams(window.location.search).get('id')
      if (currentId !== uuid) {
        window.location.href = `/?id=${uuid}`
        return null // Halt rendering
      }
    }

    return <LoginPage />
  }

  // Bypass local password setup if authenticated via Sync
  // This prevents double-setup screens
  const isSyncAuthenticated = auth.isAuthenticated

  if (!isPasswordSet && !isSyncAuthenticated) {
    return <MasterPasswordSetup />
  }

  if (isLocked && !isSyncAuthenticated) {
    return <UnlockDialog />
  }

  return (
    <Layout>
      <ScrollToTop />
      <AppRoutes />

      <AccountForm />
      <AddonInstaller />
      <ExportDialog />
      <ImportDialog />
      <Toaster />
    </Layout>
  )
}

export default App
