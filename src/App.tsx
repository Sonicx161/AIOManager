import { AccountForm } from '@/components/accounts/AccountForm'
import { AddonInstaller } from '@/components/addons/AddonInstaller'
import { MasterPasswordSetup } from '@/components/auth/MasterPasswordSetup'
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

  const { auth } = useSyncStore()

  useEffect(() => {
    const init = async () => {
      initializeUI()
      await initializeAuth()
      await initializeAccounts() // Critical: Must load accounts before failover/addons

      // These can run in parallel after accounts are loaded
      await Promise.all([
        initializeAddons(),
        initializeProfiles(),
        initializeFailover()
      ])

      startFailoverAutomation()
      setIsInitialized(true)
    }

    init()
  }, [initializeAccounts, initializeAddons, initializeAuth, initializeUI, initializeProfiles, initializeFailover, startFailoverAutomation])

  // Trigger sync when app unlocks to ensure parity
  useEffect(() => {
    if (!isLocked && auth.isAuthenticated && isInitialized) {
      console.log('[App] Vault unlocked. Triggering fresh sync.')
      // 1. Sync Cloud -> App (Pull latest changes)
      useSyncStore.getState().syncFromRemote().then(() => {
        // 2. Sync Stremio -> App (Once local state is updated from cloud)
        useAccountStore.getState().syncAllAccounts()
      }).catch(console.error)
    }
  }, [isLocked, auth.isAuthenticated, isInitialized])

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

  // Auth Guard: Force login if not authenticated OR if the local vault is locked
  if (!auth.isAuthenticated || isLocked) {
    // Check for Deep Link (Parity with AIOStreams)
    // If user visits /account/<UUID> directly, we want to pre-fill that UUID
    const path = window.location.pathname
    const match = path.match(/^\/account\/([a-zA-Z0-9-]+)/)

    if (match && match[1]) {
      // Redirect to login with ID param
      const uuid = match[1]
      const currentId = new URLSearchParams(window.location.search).get('id')
      if (currentId !== uuid) {
        window.location.href = `/?id=${uuid}`
        return null // Halt rendering
      }
    }

    return <LoginPage />
  }

  if (!isPasswordSet) {
    return <MasterPasswordSetup />
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
