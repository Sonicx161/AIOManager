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
    tag_name: 'v1.8.2',
    name: 'v1.8.2 - Share, Fix & Polish',
    published_at: new Date().toISOString(),
    html_url: 'https://github.com/sonicx161/AIOManager/releases/tag/v1.8.2',
    body: `# v1.8.2 - Share, Fix & Polish

## 🆕 New Features

### 🎬 Replay Share Links

**Your Replay is now shareable and no account is required to view it.**

Hit the **"Copy Share Link"** button at the bottom of your Replay page to generate a link you can send to anyone. When someone opens it they get the full experience: your hero stats, top titles, monthly breakdown, milestones and insights all rendered directly from the link itself.

What's included in a shared Replay:
- Your full poster mosaic (24 titles), the same rich visual display you see in the app
- Hourly and daily watch distribution charts with exact counts and hours
- Milestone progress and achievements
- Your Discoveries, Marathons and Hidden Gems lists
- Top titles with watch counts and year-over-year comparisons

**How sharing works in plain English:** Your watch data gets compressed and packed directly into the URL itself. Think of it like a very efficient digital summary tucked inside the link. There's no database involved, no server storing anything and no account needed to open it. The link loads instantly and works forever. It only contains your display name and what you've watched, nothing about your account, email or login. You're in full control of what gets shared. Links stay under 2KB so they work cleanly anywhere you'd paste a link, including Discord.

---

## 🐛 Bug Fixes & Reliability

### 🔑 AllDebrid Health Checks Now Work Again

AllDebrid updated their API behind the scenes and it quietly broke the subscription status check in AIOManager's header badges and Settings panel. Three things got fixed at once:

- Updated to AllDebrid's new API path since the old one got discontinued
- Your API key is now sent safely in the request header instead of being exposed in the URL
- Fixed a small formatting issue that was causing AIOManager's identifier to arrive garbled at AllDebrid's servers

If your AllDebrid badge was showing as unknown or throwing an error it will now correctly show your subscription status and expiry date again.

---

### 🩺 Debrid-Link Added to Provider Health

Debrid-Link was missing from the header health badges and the Settings vault panel even though it's a fully supported provider. It's now included alongside Real-Debrid, TorBox, Premiumize and AllDebrid with the same color-coded status indicators and expiry countdown you're used to seeing.

---

### 📋 Addon Changelog No Longer Cuts Off

The addon changelog was squeezed into a tiny box that only showed about 3 lines at a time so you had to scroll inside a scroll just to read anything. It now expands to use the full available height so you can actually read your update history without the hassle.

---

### 🎬 Replay Stats Animations Fixed

Two stat tiles on the Replay page, Titles Watched and Longest Binge, were silently failing to animate or show their numbers when the page loaded. The cause was an overly aggressive detection system that was wrongly treating the tiles as off screen even when they were fully visible. Both tiles now correctly animate in and display their values on load.

---

### 📅 Longest Binge Streak Calculation Fixed

The binge streak had a subtle timezone bug where it was using your local time to compare dates. That could cause your streak to show one day shorter than it actually was or occasionally break entirely depending on where you live. All date comparisons now use UTC so your streak is accurate no matter what timezone you're in.

---

### 🔭 Titles Watched Now Shows Your Discovery Count

The small subtext underneath the Titles Watched stat tile used to be a generic placeholder. It now dynamically shows your **Total Discoveries**, the number of titles you watched for the first time during that period, so the stat actually means something personal at a glance.

---

## 💝 Support

If AIOManager has saved you time, consider supporting the project:

**Ko-fi:** https://ko-fi.com/sonicx161
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
                    <h3 key={i} className="text-sm font-semibold text-foreground mt-3 mb-1 break-words leading-tight">
                        {line.replace('## ', '')}
                    </h3>
                )
                continue
            }

            // ### Subheader
            if (line.startsWith('### ')) {
                elements.push(
                    <h4 key={i} className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mt-2 mb-1 break-words leading-tight">
                        {line.replace('### ', '')}
                    </h4>
                )
                continue
            }

            // Blockquotes (> )
            if (line.startsWith('> ')) {
                const text = line.replace('> ', '').replace('[!NOTE]', '<strong>NOTE</strong>')
                elements.push(
                    <blockquote key={i} className="border-l-2 border-primary/30 pl-3 py-1.5 my-2 text-sm text-muted-foreground italic break-all bg-muted/30 rounded-r min-w-0">
                        <span dangerouslySetInnerHTML={{
                            __html: text
                                .replace(/\*\*(.*?)\*\*/g, '<strong class="text-foreground font-medium">$1</strong>')
                                .replace(/`(.*?)`/g, '<code class="text-xs bg-muted px-1 py-0.5 rounded break-all">$1</code>')
                        }} />
                    </blockquote>
                )
                continue
            }

            // Bullet points (- or *)
            if (line.match(/^\s*[-*] /)) {
                const text = line.replace(/^\s*[-*] /, '')
                elements.push(
                    <div key={i} className="flex gap-2 text-sm text-muted-foreground pl-2 min-w-0">
                        <span className="text-primary mt-0.5 flex-shrink-0">•</span>
                        <span className="break-all min-w-0 flex-1" dangerouslySetInnerHTML={{
                            __html: text
                                .replace(/\*\*(.*?)\*\*/g, '<strong class="text-foreground font-medium">$1</strong>')
                                .replace(/`(.*?)`/g, '<code class="text-xs bg-muted px-1 py-0.5 rounded break-all">$1</code>')
                        }} />
                    </div>
                )
                continue
            }

            // Regular text
            elements.push(
                <p key={i} className="text-sm text-muted-foreground break-all" dangerouslySetInnerHTML={{
                    __html: line
                        .replace(/\*\*(.*?)\*\*/g, '<strong class="text-foreground font-medium">$1</strong>')
                        .replace(/`(.*?)`/g, '<code class="text-xs bg-muted px-1 py-0.5 rounded break-all">$1</code>')
                }} />
            )
        }

        return elements
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-lg max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden">
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
