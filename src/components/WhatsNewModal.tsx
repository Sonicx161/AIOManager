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
    tag_name: `v${pkg.version}`,
    name: `v${pkg.version} - Settings, Themes & Polish`,
    published_at: new Date().toISOString(),
    html_url: `https://github.com/sonicx161/AIOManager/releases/tag/v${pkg.version}`,
    body: `# v${pkg.version} - Settings, Themes & Polish

This update completely redesigns the Settings experience, introduces expansive new developer-focused visual themes, and polishes background loading states across the application.

## ✨ New Features

**Settings Page Redesign**
The Settings page has been completely rebuilt into a clean tabbed layout — General, Appearance, Data & Sync, and Advanced — so everything has a logical home and nothing is buried. Tabs persist via URL hashes (e.g. \`#appearance\`) so you can bookmark or link directly to any section. Clear History Cache now safely lives in Data & Sync instead of the Danger Zone.

**16 New Developer Themes + Redesigned Previews**
Added 16 new developer themes: Catppuccin (Latte, Frappé, Macchiato, Mocha), Tokyo Night, Gruvbox Dark, One Dark Pro, Monokai Pro, Night Owl, Solarized Dark, Rosé Pine, SynthWave '84, Ayu Mirage, Cobalt2, Material Palenight, and GitHub Dark Dimmed. Every theme card now features a completely redesigned mini preview so you know exactly what the UI will look like before you click it.

---

## 🐛 Bug Fixes & Polish

**Background Mutations Without Flashing**
When you edit an addon's URL, name, or metadata, the library list now stays visible and dims slightly with an "Updating addon..." indicator. The page no longer completely blanks out while changes happen in the background.

**Instant Settings Loading**
Privacy mode and library view settings now read directly from \`localStorage\` on initialization. The correct state is present from the very first render, eliminating any visual flashing.

**Replace URL Dialog Flow**
The "Replace URL" dialog now automatically dismisses itself upon a successful URL replacement.

**UI Adjustments**
- **Manage Navigation**: The 'Manage' button in the sync summary now correctly routes you to the Saved Addons page as expected.
- **Metrics Visibility**: The account selector dropdown on the Metrics page now renders correctly on Sonic, Sakura, and all other light themes.
- **Provider Health Cards**: The provider health cards in Settings now use a left-aligned layout consistent with the rest of the app.
- **Local-Only Polish**: If you are a local-only user, you now get a clean "Cloud Sync not connected" message in Settings instead of a broken layout.

---

## 🧹 Maintenance

**Component Cleanup**
Removed deprecated \`ExportDialog.tsx\` and \`ImportDialog.tsx\` files as this functionality has been fully modernized and seamlessly integrated into the new Data & Sync tab.

---

## 💝 Support

I honestly feel bad even including a support section because I don't do any of this for money at all, I just wanted to build something useful. However, because so many of you keep generously reaching out and asking for ways to help, I have finally added a formal Support section to the \`README.md\` and changed the "Donate" button to a "Support" button in the footer that redirects to the bottom of the **FAQ** page where a new support section now lives. You absolutely do not have to contribute, but if you genuinely want to, here are a few ways:

**GitHub Sponsors:** https://github.com/sponsors/sonicx161

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
            const res = await fetch(`${GITHUB_RELEASES_URL}?per_page = 5`)
            if (res.ok) {
                const data: Release[] = await res.json()
                // Merge with internal release if not already fetched from GitHub
                const hasCurrent = data.some(r => r.tag_name.startsWith(`v${pkg.version}`) || r.tag_name.startsWith(pkg.version))
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

        function applyInlineFormatting(text: string): string {
            return text
                .replace(/\*\*(.*?)\*\*/g, '<strong class="text-foreground font-medium">$1</strong>')
                .replace(/`(.*?)`/g, '<code class="text-xs bg-muted px-1 py-0.5 rounded break-all">$1</code>')
                .replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">$1</a>')
                .replace(/(^|[\s])((https?:\/\/)[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline break-all">$2</a>')
        }

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
                            __html: applyInlineFormatting(text)
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
                            __html: applyInlineFormatting(text)
                        }} />
                    </div>
                )
                continue
            }

            // Regular text
            elements.push(
                <p key={i} className="text-sm text-muted-foreground break-all" dangerouslySetInnerHTML={{
                    __html: applyInlineFormatting(line)
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
                            const build = (pkg as any).build as number | undefined
                            const currentVersionStr = `${pkg.version}${build ? `+build.${build}` : ''} `
                            const isCurrentVersion = release.tag_name.replace('v', '') === currentVersionStr
                            const date = new Date(release.published_at).toLocaleDateString('en-US', {
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric',
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
