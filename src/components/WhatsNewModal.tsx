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

const INTERNAL_RELEASE: Release = {
    tag_name: 'v1.8.0',
    name: 'AIOManager v1.8.0: The Big One',
    published_at: new Date().toISOString(),
    html_url: 'https://github.com/sonicx161/AIOManager/releases/tag/v1.8.0',
    body: `# AIOManager v1.8.0: The Big One

> This is the biggest update since launch. Nearly every feature listed below is brand new. Note that some features are left out because I simply forgot about them. There's so many changes here that I lost track over time. So please explore!! 

---

## 🆕 New Features

### 🎬 Replay Page
A brand new page inspired by Apple Music Replay: your personal viewing history, visualized.
- Monthly timeline and category breakdown
- Watch statistics with streaks, top titles, and genres
- Dynamic hero cards for each month
- Animated rewind icon in the navigation bar (desktop + mobile)

### ⌨️ Command Palette
Press Ctrl+K to instantly search and navigate to any account, addon, page, or action. Power-user speed at your fingertips.

### 🔐 Zero-Knowledge Key Vault
A fully encrypted key storage system built from scratch:
- AES-256-GCM encryption: keys never leave your device in plain text
- Support for 12 providers: TorBox, Real-Debrid, Premiumize, AllDebrid, Debrid-Link, Offcloud, put.io, Easynews, EasyDebrid, PikPak, Trakt, and custom keys
- One-click "Get Token" links for each provider

### 📊 Provider Health Monitoring
Live subscription status monitoring for your debrid services:
- Real-time premium status, expiry dates, and days remaining
- Header badges with color-coded health indicators (desktop)
- Support for TorBox, Real-Debrid, Premiumize, AllDebrid, and Debrid-Link APIs

### ⚙️ Autopilot Enhancements
- **Rule Naming**: Give your failover chains custom names (e.g., "Primary Movies", "Backup Series") for better organization.
- **Per-Rule Cooldowns**: Set custom webhook notification cooldowns for each specific rule.
- **Simulation Mode**: Preview exactly what Autopilot would do before it fires — no more "surprise" failovers.

### 📋 Addon Changelog
Track every change to your addons with a dedicated changelog — installs, removals, updates, and version changes.

### 🔍 Sync Diagnostics
A new diagnostic panel in Settings showing detailed sync logs, push/pull history, and error states.

### 📦 Saved Addon Library Redesign
- New card, list, and detail views built from scratch
- Metadata editing (custom names, logos, descriptions)
- **Batch URL Paste**: Add dozens of addons at once by pasting a list of manifest URLs.
- Bulk operations and bulk URL replace

### 🎨 Emoji Picker & Account Personalization
- 170+ emojis across 7 categories with keyword search
- Theme color picker for account cards
- Personalize how each account appears in the dashboard and with a live preview! 

### 📱 What's New Modal
Users see a summary of what changed when they open the app after an update.

### 🎹 Keyboard Shortcuts Help
Press Shift+? to see all available keyboard shortcuts at a glance.

---

## ✨ Improvements

### Performance
- **Heavy Sync Protection**: Implemented backend proxy queue capping (MAX_QUEUE_SIZE) to prevent memory leaks during massive library refreshes.
- Metrics computation offloaded to a Web Worker
- **Fast Startup**: Optimized database maintenance by moving VACUUM to a background task, ensuring the app boots instantly.
- Activity feed IntersectionObserver memory leak fixed
- Toast startup guard prevents React warnings during init
- Skeleton loading states throughout the app

### Reliability & System Stability
- **Robust Link Protocol**: Unified stremio:/// link handling across Replay, Metrics, and Activity pages with a new robust opening mechanism and silent fallbacks for all browsers.
- **Sync Race-Condition Fix**: Added a cancellation flag for addon synchronization verification to prevent detached promise collisions.
- **Autopilot Sync Hardening**: Fixed missing fields (name, cooldown_ms) in global state synchronization.
- **Database Resilience**: Fixed SQLite migration edge cases and improved history pruning logic.

### UI Polish
- **Banding Elimination**: Rebranded noise textures and improved dithering algorithms to remove "visual banding" artifacts on OLED and high-contrast displays.
- **Stat Sanitization**: Removed unreliable genre data from Replay and Metrics to ensure visualizations are always clean and accurate.
- **Stale Sync Warning**: Account cards now show a yellow alert if they haven't been synced in over 24 hours.
- Mobile toast positioning clears the bottom navigation bar
- Replay animation slowed to 1.5s for a relaxed ambient feel
- **Unified Selection UI**: Cleaned up selection mode project-wide by removing empty circle placeholders and unifying grid cards to use a premium overlapping corner indicator with consistent SVG checkmarks.
- **Account Dialog Polish**: Redesigned tabs in the account editor to use a symmetrical "pill" style and added a pixel-perfect card preview that mimics the actual dashboard cards.
- **Failover Logic**: Copied rules now correctly resolve addon names across all accounts.
- **Account Filters**: Metrics account filter now hides accounts with no history for a cleaner view.
- Removed redundant profile count badges
- Provider badges hidden on tablets (desktop only)

### Security & Privacy
- **Encryption Hardening**: Secure library import hardening and encrypted webhook storage for failover notifications.
- Zero-Knowledge key storage for all debrid providers.

---
### A Note From Me

I wanted to take the time to say a massive thank you. When I first pushed this project public, I genuinely expected maybe a handful of people to find it. AIOManager started as something I built strictly for myself out of curiosity and personal use. I just wanted to put it out there to show what I could do and help whoever bumped into it. I appreciate all of you who are using this and the kind words you always share.

I would like to note that I am still following through with the following from the README: 

> [!NOTE]
> Maintenance Status
> AIOManager is now in maintenance mode. Active feature development has wrapped up with v1.7.0. Bug reports via GitHub Issues are welcome and PRs from the community are always open. Maintenance is done on a best-effort basis.

I wanted to release this update after noting all of that because I want this to be as close to perfect as possible before I slow down full stop. I had a random burst of wanting to make everything better and include the replay stuff. You can really thank "replay" for this specific update. 

I know some of you have seen firsthand the sacrifice I have taken to keep working on this project. I have truthfully sacrificed a month of time that could have been used in my personal life (I've been teetering a dangerous line in terms of things that need more urgent attention), but I do not resent it and would do it over again. I love knowing that I am helping at least one person out there. I really need to focus on life priorities now, and I wish I were in a better place to pour more love into this than I already have, but I will still be fixing bugs from time to time when I can.

You are all amazing people and I hope you enjoy all the work I put into this big update. 

Love you all <3 
---

## 💝 Support

If AIOManager has saved you time or helped your workflow, consider supporting the project:

Ko-fi: https://ko-fi.com/sonicx161
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
                const hasCurrent = data.some(r => r.tag_name === 'v1.8.0' || r.tag_name === '1.8.0')
                setReleases(hasCurrent ? data : [INTERNAL_RELEASE, ...data])
            } else {
                setReleases([INTERNAL_RELEASE])
            }
        } catch {
            // Fallback to internal release if fetch completely fails (e.g., adblock, offline)
            setReleases([INTERNAL_RELEASE])
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
