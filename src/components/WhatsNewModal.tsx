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
    tag_name: 'v1.8.3',
    name: 'v1.8.3 - Theme Compatibility',
    published_at: new Date().toISOString(),
    html_url: 'https://github.com/sonicx161/AIOManager/releases/tag/v1.8.3',
    body: `# v1.8.3 - Theme Compatibility

## 🎨 Full Theme Compatibility

Every UI component now renders correctly across all 27 themes. Previously, hardcoded white/dark color values made text invisible or elements unreadable on light and custom themes like Sonic, Sakura, and others.

### Components updated:
- **Saved Addon cards and list rows** — all inline rgba(255,255,255,...) and color: 'white' replaced with CSS variable equivalents. Text, borders, backgrounds, and hover states now adapt to every theme
- **Failover Manager** — card backgrounds, borders, dividers, status text, chain displays, and log entries
- **Header** — navigation pill, provider health badges, user identity section, dropdown dividers
- **Addon Changelog** — empty state backgrounds, timestamp colors, and action badges (installed/removed/updated)
- **Saved Addon Library** — list view borders, empty state cards, Update All button
- **Addon Cards & Lists** — update/protected badges, toggle/protect/reinstall/save buttons, Autopilot button
- **Batch Operations** — warning and info banners, result status badges, checkboxes
- **Account Card & Form** — failover status text, health indicators, code blocks, color picker borders
- **Login Page** — auth key display, warning boxes
- **Settings & Vault** — synced addon rows, masked key container, provider health badges
- **FAQ Page** — code block backgrounds
- **Cinemeta Configuration** — "Patched" badges
- **Install dialogs** — success messages
- **Dropdown menus** — destructive variant colors
- **Error Boundary** — reload button text contrast
- **CSS (index.css)** — mesh-gradient, vignette overlay, scrollbar colors
- **Suspense fallbacks** — hardcoded #08080f replaced with theme background variable

### Mobile PWA Experience
The mobile status bar (notch area) now dynamically updates its \`theme-color\` to seamlessly match your active theme's background, instead of being permanently stuck on midnight black.

### Replay Dark Canvas
Replay pages now render on a forced dark background regardless of active theme since they were designed for the midnight canvas.

---

## 🐛 Bug Fixes

### Replay Share Loading Flash
The Replay Share page was briefly flashing the error screen before the data loaded because the initial state was set to 'error'. Changed to 'loading' with a clean dark background while the share token decodes.

### Autopilot Database Fix
Fixed a crash on existing databases where the autopilot_rules table was missing the is_active column. A migration now adds the column automatically so Autopilot works on first launch without manual database changes.

### Deprecated Flows Removed
Removed the master password setup and forgot password flows which were deprecated from the original project.

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
                const hasCurrent = data.some(r => r.tag_name === 'v1.8.3' || r.tag_name === '1.8.3')
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
