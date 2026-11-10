import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CheckCircle2, ExternalLink, Loader2, Sparkles } from 'lucide-react'
import { useEffect, useState, useCallback } from 'react'
import pkg from '../../package.json'
import { useUIStore } from '@/store/uiStore'
import { useSyncStore } from '@/store/syncStore'
import { openWhenNoTextEntry } from '@/lib/text-entry-focus'

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
    name: `v${pkg.version}`,
    published_at: new Date().toISOString(),
    html_url: `https://github.com/sonicx161/AIOManager/releases/tag/v${pkg.version}`,
    body: `### Connections

- **Multi-platform connections** - Mirror your addon configuration to Stremio, Nuvio, Hydra (inbound and outbound), and RealStream from a single account.

- **Bidirectional reconciler** - The sync engine detects changes on both sides and propagates them. Addons added or removed on any connected platform sync to all others.

- **Connection API keys** - Credentials are encrypted at rest on the server using AES-256-GCM and never exposed to the client after initial setup.

- **RealStream driver** - Native RealStream integration with server-side token custody and automatic refresh.

### Discover

- **New Discover tab** - Browse and install community addons directly from the addon page.

### Security

- **SSRF protection with DNS resolution** - Server-side URL validation now resolves DNS to block private IP ranges, preventing internal network scanning.

- **Per-record sync salt** - Each sync payload uses a unique salt, preventing key derivation attacks across users.

- **Race condition mutexes** - Profile switching and sync writes are serialized to prevent data corruption under concurrent access.

- **Tombstone system** - Deleted addons are tracked with tombstones to prevent accidental resurrection during sync.

- **Backfill episode recovery** - Watch history repair now recovers missing episode data from available sources.

- **Anti-wipe guard** - Bulk addon removal is blocked unless triggered by a legitimate profile switch.

### UI

- **Container patterns** - Consistent card and wrapper styling across the app with proper border, shadow, and background treatment.

- **Button variants** - Toolbar and action buttons now use the \`outline\` variant for visual hierarchy. Dialog actions use \`subtle\`.

- **Connection cards** - Connections are displayed as clickable cards with hover lift and chevron indicators. No more three-dot menus.

### Fixes

- **Replay share links** - Share links for watch history replays now generate correctly.

- **Binge streak fixes** - Streak calculations now properly handle midnight boundaries and timezone offsets.
`
}

export function WhatsNewModal({ triggerOpen, onOpenChange }: {
    triggerOpen?: boolean
    onOpenChange?: (open: boolean) => void
}) {
    const currentVersion = pkg.version
    const open = useUIStore(s => s.isWhatsNewOpen)
    const setOpen = useUIStore(s => s.setWhatsNewOpen)
    const lastSeenVersion = useSyncStore(s => s.lastSeenVersion)
    const setLastSeenVersion = useSyncStore(s => s.setLastSeenVersion)
    const [releases, setReleases] = useState<Release[]>([])
    const [loading, setLoading] = useState(false)

    const fetchReleases = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch(`${GITHUB_RELEASES_URL}?per_page=5`)
            if (res.ok) {
                const data: Release[] = await res.json()
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

    useEffect(() => {
        if (open && releases.length === 0) {
            fetchReleases()
        }
    }, [open, releases.length, fetchReleases])

    useEffect(() => {
        // The operator console is not the app; release notes wait for the next app visit.
        if (window.location.pathname.startsWith('/dashboard')) return
        if (lastSeenVersion !== currentVersion) {
            // Small delay so the app finishes mounting first, and the dialog never pulls
            // focus out of a field the user is typing in.
            return openWhenNoTextEntry(() => setOpen(true), 1500)
        }
    }, [currentVersion, setOpen, lastSeenVersion])

    useEffect(() => {
        if (triggerOpen) {
            setOpen(true)
        }
    }, [triggerOpen, setOpen])

    const handleOpenChange = (value: boolean) => {
        setOpen(value)
        onOpenChange?.(value)
        if (!value) {
            setLastSeenVersion(currentVersion)
        }
    }

    function renderBody(body: string) {
        const lines = body.split('\n')
        const elements: React.ReactNode[] = []

        function applyInlineFormatting(text: string): string {
            // Strip any raw HTML tags from input before processing -
            // release note content should only contain markdown, not HTML.
            const stripped = text.replace(/<[^>]*>/g, '')
            return stripped
                .replace(/\*\*(.*?)\*\*/g, '<strong class="text-foreground font-semibold">$1</strong>')
                .replace(/`(.*?)`/g, '<code class="text-[11px] bg-muted/70 border border-border/40 px-1.5 py-0.5 rounded-md break-all">$1</code>')
                .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">$1</a>')
                .replace(/(^|[\s])((https?:\/\/)[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline break-all">$2</a>')
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]

            if (!line.trim()) {
                elements.push(<div key={i} className="h-2" />)
                continue
            }

            if (line.startsWith('## ')) {
                elements.push(
                    <h3 key={i} className="mt-4 text-sm font-bold text-foreground break-words leading-tight">
                        {line.replace('## ', '')}
                    </h3>
                )
                continue
            }

            if (line.startsWith('### ')) {
                elements.push(
                    <h4 key={i} className="mt-4 mb-2 text-xs font-bold text-muted-foreground uppercase tracking-[0.14em] break-words leading-tight">
                        {line.replace('### ', '')}
                    </h4>
                )
                continue
            }

            if (line.startsWith('> ')) {
                const text = line.replace('> ', '').replace('[!NOTE]', '<strong>NOTE</strong>')
                elements.push(
                    <blockquote key={i} className="my-2 rounded-r-xl border-l-2 border-primary/30 bg-muted/30 py-2 pl-3 text-sm text-muted-foreground italic break-words min-w-0">
                        <span dangerouslySetInnerHTML={{
                            __html: applyInlineFormatting(text)
                        }} />
                    </blockquote>
                )
                continue
            }

            if (line.match(/^\s*[-*] /)) {
                const text = line.replace(/^\s*[-*] /, '')
                elements.push(
                    <div key={i} className="flex gap-2.5 text-sm leading-6 text-muted-foreground min-w-0">
                        <span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />
                        <span className="break-words min-w-0 flex-1" dangerouslySetInnerHTML={{
                            __html: applyInlineFormatting(text)
                        }} />
                    </div>
                )
                continue
            }

            elements.push(
                <p key={i} className="text-sm leading-6 text-muted-foreground break-words" dangerouslySetInnerHTML={{
                    __html: applyInlineFormatting(line)
                }} />
            )
        }

        return elements
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="flex max-h-[88vh] min-h-0 sm:w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">

                <DialogHeader className="flex-shrink-0 border-b border-border/30 bg-card px-6 pb-4 pt-6">
                    <div className="flex items-start gap-3 pr-10">
                        <div data-theme-part="badge" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/40 bg-muted/25 text-primary">
                            <Sparkles className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                            <DialogTitle className="text-xl tracking-tight">What's New</DialogTitle>
                            <p className="mt-1 text-sm text-muted-foreground">
                                Latest updates, fixes, and quality-of-life improvements.
                            </p>
                        </div>
                    </div>
                </DialogHeader>


                <div className="min-h-0 flex-1 overflow-y-auto bg-card">
                    <div className="space-y-1 px-5 py-5 sm:px-7">
                        {loading && (
                            <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
                                <Loader2 className="h-5 w-5 animate-spin" />
                                Loading releases...
                            </div>
                        )}

                        {!loading && releases.length === 0 && (
                            <div className="py-14 text-center text-sm text-muted-foreground">
                                No release notes available.
                            </div>
                        )}

                        {!loading && releases.map((release) => {
                            const build = (pkg as { build?: number }).build
                            const currentVersionStr = `${pkg.version}${build ? `+build.${build}` : ''}`
                            const isCurrentVersion = release.tag_name.replace('v', '') === currentVersionStr
                            const date = new Date(release.published_at).toLocaleDateString('en-US', {
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric',
                            })

                            return (
                                <section key={release.tag_name} className="relative border-l border-border/35 py-4 pl-5 first:pt-0 last:pb-0">
                                    <span className="absolute -left-[4.5px] top-6 h-2 w-2 rounded-full bg-primary ring-4 ring-card" />

                                    <div className="mb-3 flex flex-wrap items-center gap-2">
                                        <Badge variant={isCurrentVersion ? 'default' : 'secondary'} className={isCurrentVersion ? 'border-primary/25 bg-primary/10 text-primary' : 'border-border/40 bg-muted/20 text-muted-foreground'}>
                                            {release.tag_name}
                                        </Badge>
                                        <span className="text-sm font-semibold text-foreground">{release.name || release.tag_name}</span>
                                        <span className="ml-auto text-xs text-muted-foreground">{date}</span>
                                        {isCurrentVersion && (
                                            <span data-theme-part="badge" className="inline-flex items-center gap-1 rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-xs font-bold uppercase tracking-[0.08em] text-success">
                                                <CheckCircle2 className="h-3 w-3" />
                                                Current
                                            </span>
                                        )}
                                    </div>


                                    <div className="space-y-1.5">
                                        {renderBody(release.body || 'No release notes provided.')}
                                    </div>
                                </section>
                            )
                        })}
                    </div>
                </div>


                <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-border/30 bg-card px-4 py-3 sm:px-6">
                    <Button variant="ghost" size="sm" asChild className="gap-1.5 rounded-xl">
                        <a
                            href="https://github.com/sonicx161/AIOManager/releases"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <ExternalLink className="h-3.5 w-3.5" />
                            All Releases
                        </a>
                    </Button>
                    <Button size="sm" onClick={() => handleOpenChange(false)} className="rounded-xl px-5">
                        Got it
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
