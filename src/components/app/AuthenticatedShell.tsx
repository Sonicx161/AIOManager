import { useEffect, useState } from 'react'
import { Layout } from '@/components/layout/Layout'
import { ScrollToTop } from '@/components/ScrollToTop'
import { Toaster } from '@/components/ui/toaster'
import { DeployDecisionHost } from '@/components/saved-addons/DeployDecisionSheet'
import { AppRoutes } from '@/routes'
import { useUIStore } from '@/store/uiStore'
import { DeviceNameDialog } from '@/components/auth/DeviceNameDialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Suspense } from 'react'

import { lazyChunk } from '@/lib/lazy-chunk'

// Always-mounted modals are dead weight in the entry chunk: lazy + latch them so the code loads
// on first open (off the critical path) and stays mounted afterward to keep open/close animations.
const AccountForm = lazyChunk(() => import('@/components/accounts/AccountForm').then(m => ({ default: m.AccountForm })))
const AddonInstaller = lazyChunk(() => import('@/components/addons/AddonInstaller').then(m => ({ default: m.AddonInstaller })))
const KeybindingsHelp = lazyChunk(() => import('@/components/KeybindingsHelp').then(m => ({ default: m.KeybindingsHelp })))
const WhatsNewModal = lazyChunk(() => import('@/components/WhatsNewModal').then(m => ({ default: m.WhatsNewModal })))

interface AuthenticatedShellProps {
    shortcutsOpen: boolean
    onShortcutsClose: () => void
}

// The authenticated app shell (header, palette host, toasts, always-mounted
// dialogs) lives in its own chunk so the boot closure only carries the login
// path; it is preloaded during boot init once a session exists.
export default function AuthenticatedShell({ shortcutsOpen, onShortcutsClose }: AuthenticatedShellProps) {
    const [deferredModalsMounted, setDeferredModalsMounted] = useState(false)
    useEffect(() => { const t = setTimeout(() => setDeferredModalsMounted(true), 150); return () => clearTimeout(t) }, [])
    const isAddAccountDialogOpen = useUIStore((state) => state.isAddAccountDialogOpen)
    const isAddAddonDialogOpen = useUIStore((state) => state.isAddAddonDialogOpen)
    // Latch: flip true on first open and stay true (keeps the modal mounted for close animations).
    const [accountFormSeen, setAccountFormSeen] = useState(false)
    const [addonInstallerSeen, setAddonInstallerSeen] = useState(false)
    const [keybindingsSeen, setKeybindingsSeen] = useState(false)

    useEffect(() => { if (isAddAccountDialogOpen) setAccountFormSeen(true) }, [isAddAccountDialogOpen])
    useEffect(() => { if (isAddAddonDialogOpen) setAddonInstallerSeen(true) }, [isAddAddonDialogOpen])
    useEffect(() => { if (shortcutsOpen) setKeybindingsSeen(true) }, [shortcutsOpen])

    return (
        <TooltipProvider delayDuration={700} skipDelayDuration={0}>
            <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-0 focus:left-0 focus:z-50 focus:p-4 focus:bg-background focus:text-foreground">Skip to main content</a>
            <Layout>
                <ScrollToTop />
                <AppRoutes />

                {accountFormSeen && <Suspense fallback={null}><AccountForm /></Suspense>}
                {addonInstallerSeen && <Suspense fallback={null}><AddonInstaller /></Suspense>}

                {deferredModalsMounted && <Suspense fallback={null}><WhatsNewModal /></Suspense>}
                {keybindingsSeen && <Suspense fallback={null}><KeybindingsHelp isOpen={shortcutsOpen} onClose={onShortcutsClose} /></Suspense>}
            </Layout>
            <Toaster />
            <DeployDecisionHost />
            <DeviceNameDialog />
        </TooltipProvider>
    )
}
