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
    name: `v${pkg.version} - Performance, Autopilot & UI`,
    published_at: new Date().toISOString(),
    html_url: `https://github.com/sonicx161/AIOManager/releases/tag/v${pkg.version}`,
    body: `# v1.8.5 — Performance, Autopilot & UI

A deep maintenance release focused on fixing silent failures that have been building up under the hood since v1.8.0. No flashy new pages this time. There were just a lot of things that were quietly broken and are now quietly fixed, plus a new Refresh & Cache management system, a webhook notification system rework for Autopilot, and a full visual pass on the Saved Addons page.

---

## 🌟 New Features

**Refresh Choice Dropdown.** The old single-purpose refresh button on the Accounts page has been upgraded to a full management dropdown. You now have granular control over your local data: trigger a global addon update check for all accounts with a live loading spinner for progress, or prune specific local caches without needing a full session reset.
---

## ⚡ Autopilot Database Optimization

The Autopilot worker was previously triggering unconditional database writes on every heartbeat cycle, even when no state had changed. This was caused by three compounding logic errors that are now resolved.

All three bugs are now fixed:

- The worker was encrypting the stabilization state to compare it to the stored value. Because the encryption uses a random IV, two encryptions of identical plaintext always produce different ciphertext — so the "did anything change?" check was always returning yes, always writing.
- Even after fixing that, the success/failure counters inside the stabilization object would keep incrementing every cycle on a healthy instance, meaning the JSON would change anyway (\`{successes: 1}\` → \`{successes: 2}\` → ...) and the early-return would never fire.
- A 5-minute forced heartbeat write was also running unconditionally as a fallback.

With all three fixed: **on a stable, healthy instance, the worker now produces zero database writes per cycle.** Writes only happen when something actually changes — a failover, a recovery, or a rule violation. For most users this means the worker runs silently for hours or days at a time without touching the database at all.

---

## 🔔 Autopilot Webhook Notifications

Autopilot can now send you a notification when it does something.

Set a **Global Webhook** in the Webhooks tab inside any account's Failover Manager. AIOManager auto-detects whether the URL is a Discord webhook, Slack incoming webhook, or a generic JSON endpoint and formats the payload accordingly. The global webhook is the fallback for all rules — if a rule doesn't have its own, it inherits this one.

Each rule can also have its own **custom webhook URL** that overrides the global one, a **per-rule notification cooldown** so you don't get spammed during flapping events, and can be set to off entirely if you want that rule to stay silent.

A **Test button** is available directly on the global webhook config, inside the rule creation dialog, and on any rule row that has a custom URL set.

---

## 🐛 Autopilot: Two Silent Failures Fixed

**Manual-only rules were running as automatic.** The worker's SELECT query was missing the \`is_automatic\` column. Since it never loaded, the manual-only guard never fired — every rule ran on the automatic schedule regardless of how you configured it.

**Live Mode syncs were silently broken for self-hosted users.** A stray space in the API path construction was generating a URL like \`/base /api/autopilot/rules\` instead of \`/base/api/autopilot/rules\`. The server returned 404 and the sync failed silently — no error shown, rules just never propagated. If you're running a remote sync server and noticed your Autopilot rules weren't sticking, this was why.

---

## 🐛 Other Bug Fixes

**Global webhook went stale after saving.** Updating the global webhook URL in the UI looked like it worked, but the server kept using the old URL until the next restart. Rules that use the default webhook now re-sync immediately when you save a new global URL.

**Update checks were causing 429 bursts on self-hosted addon servers.** When you clicked "Check for Addon Updates," the app was firing a separate manifest fetch pass per account — so if you have 8 accounts all running the same AIOStreams instance, it would hit that server 8 times in rapid succession. The check now deduplicates addon URLs globally before fetching, so each unique addon server is hit exactly once per check run regardless of how many accounts share it.

**Health checks were making network requests to local/private-IP addons.** If you had addons with local addresses (192.168.x.x, 10.x.x.x, etc.) in your library, the app was making live network requests that were guaranteed to fail with \`ERR_CONNECTION_REFUSED\`. These are now skipped before the request is made.

**OpenSubtitles v1 console spam.** The deprecated \`opensubtitles.strem.io\` endpoint returns an HTML error page instead of JSON, causing a \`SyntaxError: Unexpected token '<'\` on every single update check for anyone who has it installed. These are now silently skipped.

**Test webhook endpoint had no SSRF protection.** The \`/api/autopilot/test-webhook\` endpoint would fire an outbound request to any URL without validation. It now runs through the same \`isSafeUrl\` guard as all other proxied requests.

---

## 🎨 Saved Addon Library — Visual Overhaul

The Addons page got a full visual pass to bring it in line with the rest of the app.

**Sidebar** was rebuilt as a proper panel — \`bg-muted/30\` container with rounded-2xl border, primary active states, and a clean PROFILES label. The old flat ghost button list is gone.

**Toolbar** was decluttered. Health indicators (Online · Offline) sit on the left, action buttons on the right in a consistent h-8 row. No more floating stats-in-a-box.

**Cards** — hover state now uses Tailwind instead of \`onMouseEnter\`/\`onMouseLeave\` inline style manipulation. Footer got a proper \`border-t\` separator with profile name left and relative timestamp right.

**Profile section headers** now use the full divider-line treatment with a collapse chevron, matching the rest of the app's section language.

---

## 🔔 Tabs No Longer Require Swiping on Mobile

Every pill-tab row in the app (Accounts, Activity, Failover Manager, Settings, Addons) now wraps to a second line on small screens instead of scrolling horizontally. The Metrics page already had this correct behavior — everything else now matches it.

---

## 🔧 Smaller Fixes

- Button height inconsistency between "New Rule" (h-8) and "Copy Rules From…" (h-7) in Failover Manager — both are now h-8
- "Update All" button on the Accounts page was hardcoded blue — now uses your active theme's primary color like every other button
- Selection toolbar on the Addons page was clipping through the app header on scroll — now correctly offsets below it
- \`latestVersions\` map was growing unboundedly in localforage, writing a larger payload on every update check as you uninstalled addons over time — now pruned after each merge
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
