import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sparkles, ExternalLink, Loader2 } from 'lucide-react'
import { useEffect, useState, useCallback } from 'react'
import pkg from '../../package.json'
import { useUIStore } from '@/store/uiStore'
import { useSyncStore } from '@/store/syncStore'

interface Release {
    tag_name: string
    name: string
    body: string
    published_at: string
    html_url: string
}

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/sonicx161/AIOManager/releases'

const FALLBACK_RELEASE: Release = {
    tag_name: 'v1.8.1',
    name: 'AIOManager v1.8.1: Sync & Mobile Refinements',
    published_at: new Date().toISOString(),
    html_url: 'https://github.com/sonicx161/AIOManager/releases/tag/v1.8.1',
    body: `# AIOManager v1.8.1: Sync & Mobile Refinements

> A massive follow-up to The Big One, focused heavily on bulletproofing our sync engine, crushing a significant backlog of Discord-reported bugs, and drastically improving the mobile experience across the entire application.

> [!NOTE]
> **Known Visual Behavior**
> There may be minor visual glitches where Autopilot failover backups do not immediately show up as "disabled" (greyed out) in the UI. A quick page refresh will automatically flip them off on the frontend as intended.

---

## 🆕 New Features

### 📦 Enhanced Addon Management & Selection
- **Bulk Operations:** Added "Clone" and "Deploy to All" bulk actions directly in the AddonList.
- **Long Press Support:** Formally introduced a \`useLongPress\` hook to easily trigger selection mode on mobile devices (and desktop).
- **View Mode Persistence:** 'Grid' and 'List' view preferences are now remembered via localStorage across Saved, Discover, and Library interfaces.

### 🎛️ Headers, Popovers & UI
- **Debrid Provider Enhancements:** Improved formatting of Debrid expiration dates and embedded API Dashboard links directly into the dropdowns.
- **Project Documentation:** Shipped a full \`CONTRIBUTING.md\` manifesto to outline the tech stack and project expectations for external contributors.

---

## ✨ UI Polish & Mobile Refinements

### 📱 Perfecting the Mobile Experience
- **Replay Dashboard Responsive Overhaul:** 
  - live counter tiles now gracefully stack (using \`flex-wrap\`) instead of clipping off-screen on narrow viewports.
  - The massive 380px posteris now encapsulated in a horizontal scrolling envelope allowing for native swiping.
  - Ribbon dynamically scales down font sizes for long strings (e.g., "Wednesday") and cleanly wraps onto multiple rows without aggressively slicing words in half.
- **Global Dialog Constraints:** All \`DialogContent\` and \`AlertDialogContent\` elements globally now have strict mobile viewport constraints (\`95vh\`, \`95vw\`, \`overflow-y-auto\`). Nothing will overflow your screen again.
- **Context Menu Flow:** Addon dropdowns in the AddonList align smartly on mobile to prevent clipping, and context menus are completely hidden while in "Select Mode" to prevent blocking clicks.
- **Toast Clearances:** Logically offset bottom toasts on mobile devices so they no longer overlap with the bottom navigation bar.

### 🎨 General UI Cleanup
- Trimmed the fat on the Addon Card hamburger menu by removing redundant 'Configure Metadata' and 'Refresh Addon' items.
- Added headers into the hamburger menu's (a small but really nice visual change in my opinion) 


---

## 🐛 Bug Fixes & Reliability

### 🔄 Bulletproof Addon Synchronization
- **Cinemeta Patch Persistence:** Added optimistic local state isolation. "Patched" configs no longer mysteriously reset or revert back to the official state during background sync cycles.
- **Incognito Sync Consistency:** The engine auto-populates \`cinemetaConfig\` if it detects heavily customized \`stremio-cinemeta\` manifests to guarantee alignment for users utilizing Incognito mode or multi-device setups without triggering false config dialogues.
- **Complex Object Parsing:** Upgraded \`detectMetaResourcePatched\` to properly inspect object-based resource nodes (like hiding standard catalogs), fixing a major detection failure.
- **Disabled Addon Purging Fix:** Resolved a critical bug where disabled addons (like Autopilot fallbacks) were being mistakenly purged from local state due to 'missing from remote' API checks.
- **Fast Reinstall Protection:** Implemented an optimistic update when using the Fast Reinstall button to prevent background sync loops from reverting uninstallation.

### 🛠️ App Stability & Logic
- **CORS Image Blocking Resolved:** Stripped strict \`crossOrigin\` attributes from the base Poster component to completely resolve blocking CORS proxy issues from remote endpoints like TMDB and Metahub.
- **URL Configuration Whitespace:** Resolved an anomaly where auto-generated \`/configure\` URLs for internally routed addons were injecting a rogue \`%20\` space and breaking autofill routing.
- **Metrics Navigation Freeze:** Fixed infinite freezing when navigating away from the Metrics page caused by React 18 Strict Mode by properly resetting Web Worker fingerprint references on unmount.
- **Infinite Spinner Catch:** Wrapped the \`syncAllAccounts\` routine in a generic \`try/finally\` block to prevent the app from freezing up during cloned API failures.
- **Sync Order Standardization:** Forced an immediate data sync at the end of \`bulkSyncOrder\` to prevent layout order inconsistencies and trailing state loops.
- **Autopilot UI Refresh:** Added an immediate UI refresh sweep when Autopilot forcibly swaps a server state to reflect the exact scenario in real-time.
- **React Warnings Crushed:** Solved the notorious "Can't perform a React state update on a component that hasn't mounted yet" error within the toast system, and optimized \`accountStore\` to utilize functional state updates to mitigate parallel sync race conditions.
- **Dynamic Vault Names:** Replaced hardcoded 'TB Account' names with your dynamically parsed, custom vault key names (Sorry it was left over from the initial implementation test lol. But we love TB. Shoutout to Mike & Wamy and the Torbox Team <3) 
- **Infinite Spinning:** Fixed the infinite spinning 'Reinstall' button animation by applying proper transition timeouts.
`
}

/**
 * "What's New" changelog modal.
 * - Auto-shows once per version upgrade (checks localStorage).
 * - Fetches the latest 5 releases from GitHub and renders the body as formatted text.
 * - Can also be manually triggered via `triggerOpen`.
 */
export function WhatsNewModal({ triggerOpen, onOpenChange }: {
    triggerOpen?: boolean
    onOpenChange?: (open: boolean) => void
}) {
    const currentVersion = pkg.version
    const { isWhatsNewOpen: open, setWhatsNewOpen: setOpen } = useUIStore()
    const { lastSeenVersion, setLastSeenVersion } = useSyncStore()
    const [releases, setReleases] = useState<Release[]>([])
    const [loading, setLoading] = useState(false)

    const fetchReleases = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch(`${GITHUB_RELEASES_URL}?per_page=5`)
            if (res.ok) {
                const data: Release[] = await res.json()
                // Merge with internal release if not already fetched from GitHub
                const hasCurrent = data.some(r => r.tag_name === 'v1.8.1' || r.tag_name === '1.8.1')
                setReleases(hasCurrent ? data : [FALLBACK_RELEASE, ...data])
            } else {
                setReleases([FALLBACK_RELEASE])
            }
        } catch {
            // Fallback to internal release if fetch completely fails (e.g., adblock, offline)
            setReleases([FALLBACK_RELEASE])
        } finally {
            setLoading(false)
        }
    }, [])

    // Trigger fetch when modal opens
    useEffect(() => {
        if (open && releases.length === 0) {
            fetchReleases()
        }
    }, [open, releases.length, fetchReleases])

    // Auto-show on version upgrade
    useEffect(() => {
        if (lastSeenVersion !== currentVersion) {
            // Small delay so the app finishes mounting first
            const timer = setTimeout(() => {
                setOpen(true)
            }, 1500)
            return () => clearTimeout(timer)
        }
    }, [currentVersion, setOpen, lastSeenVersion])

    // Manual trigger support (if passed as prop)
    useEffect(() => {
        if (triggerOpen) {
            setOpen(true)
        }
    }, [triggerOpen, setOpen])

    const handleOpenChange = (value: boolean) => {
        setOpen(value)
        onOpenChange?.(value)
        if (!value) {
            // Mark as seen when closing
            setLastSeenVersion(currentVersion)
        }
    }

    /** Simple markdown-ish to JSX: handles headers, bold, bullets, and links */
    function renderBody(body: string) {
        const lines = body.split('\n')
        const elements: React.ReactNode[] = []

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]

            // Skip empty lines
            if (!line.trim()) {
                elements.push(<div key={i} className="h-2" />)
                continue
            }

            // ## Header
            if (line.startsWith('## ')) {
                elements.push(
                    <h3 key={i} className="text-sm font-semibold text-foreground mt-3 mb-1">
                        {line.replace('## ', '')}
                    </h3>
                )
                continue
            }

            // ### Subheader
            if (line.startsWith('### ')) {
                elements.push(
                    <h4 key={i} className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mt-2 mb-1">
                        {line.replace('### ', '')}
                    </h4>
                )
                continue
            }

            // Bullet points (- or *)
            if (line.match(/^\s*[-*] /)) {
                const text = line.replace(/^\s*[-*] /, '')
                elements.push(
                    <div key={i} className="flex gap-2 text-sm text-muted-foreground pl-2">
                        <span className="text-primary mt-0.5 flex-shrink-0">•</span>
                        <span dangerouslySetInnerHTML={{
                            __html: text
                                .replace(/\*\*(.*?)\*\*/g, '<strong class="text-foreground font-medium">$1</strong>')
                                .replace(/`(.*?)`/g, '<code class="text-xs bg-muted px-1 py-0.5 rounded">$1</code>')
                        }} />
                    </div>
                )
                continue
            }

            // Regular text
            elements.push(
                <p key={i} className="text-sm text-muted-foreground" dangerouslySetInnerHTML={{
                    __html: line
                        .replace(/\*\*(.*?)\*\*/g, '<strong class="text-foreground font-medium">$1</strong>')
                        .replace(/`(.*?)`/g, '<code class="text-xs bg-muted px-1 py-0.5 rounded">$1</code>')
                }} />
            )
        }

        return elements
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-lg max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden">
                {/* Header */}
                <DialogHeader className="px-6 pt-6 pb-4 border-b bg-gradient-to-b from-primary/5 to-transparent flex-shrink-0">
                    <DialogTitle className="flex items-center gap-2 text-lg">
                        <Sparkles className="h-5 w-5 text-primary" />
                        What's New
                    </DialogTitle>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        Latest updates and improvements
                    </p>
                </DialogHeader>

                {/* Content */}
                <ScrollArea className="flex-1 overflow-auto">
                    <div className="px-6 py-4 space-y-6">
                        {loading && (
                            <div className="flex items-center justify-center py-12 text-muted-foreground">
                                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                                Loading releases...
                            </div>
                        )}

                        {!loading && releases.length === 0 && (
                            <div className="text-center py-12 text-muted-foreground text-sm">
                                No release notes available.
                            </div>
                        )}

                        {!loading && releases.map((release, idx) => {
                            const isCurrentVersion = release.tag_name.replace('v', '') === currentVersion
                            const date = new Date(release.published_at).toLocaleDateString('en-US', {
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric'
                            })

                            return (
                                <div key={release.tag_name}>
                                    {/* Version header */}
                                    <div className="flex items-center gap-2 mb-2">
                                        <Badge
                                            variant={isCurrentVersion ? 'default' : 'secondary'}
                                            className={isCurrentVersion ? 'bg-primary/15 text-primary border-primary/20' : ''}
                                        >
                                            {release.tag_name}
                                        </Badge>
                                        {isCurrentVersion && (
                                            <span className="text-[10px] uppercase tracking-wider text-primary font-semibold">
                                                Current
                                            </span>
                                        )}
                                        <span className="text-xs text-muted-foreground ml-auto">{date}</span>
                                    </div>

                                    {/* Release body */}
                                    <div className="space-y-1">
                                        {renderBody(release.body || 'No release notes provided.')}
                                    </div>

                                    {/* Separator between releases */}
                                    {idx < releases.length - 1 && (
                                        <div className="border-t mt-4" />
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </ScrollArea>

                {/* Footer */}
                <div className="px-6 py-3 border-t flex-shrink-0 flex items-center justify-between bg-card/50">
                    <Button variant="ghost" size="sm" asChild>
                        <a
                            href="https://github.com/sonicx161/AIOManager/releases"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                            All Releases
                        </a>
                    </Button>
                    <Button size="sm" onClick={() => handleOpenChange(false)}>
                        Got it
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
