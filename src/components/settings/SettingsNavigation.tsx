import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { HighlightText } from '@/components/ui/highlight-text'
import { cn } from '@/lib/utils'
import { canInstall, subscribeInstall } from '@/lib/pwa'
import { SETTING_PAGE_LABELS, type SettingsPageId } from './settings-model'

export type { SettingsPageId }

export { SETTING_PAGE_LABELS }

export interface SettingSearchEntry {
    /** Unique id for React keys. */
    id: string
    /** Detail page that contains this section. */
    page: SettingsPageId
    /** Section title as shown in the settings UI. */
    title: string
    /** Short summary of the controls living in this section. */
    description: string
    /** Plain-language terms users may type when looking for this section. */
    keywords: string[]
    /** Optional inner heading text. When present, the search jumps to that
     * exact heading inside the anchored section instead of the section top. */
    heading?: string
    /** Anchor id when it differs from `id` (e.g. sub-sections inside one
     * anchored component). Defaults to `id`. */
    anchor?: string
}

export interface SettingSearchMatch {
    entry: SettingSearchEntry
    matchedKeywords: string[]
}

/**
 * Static index over the EXISTING settings sections. This only describes what
 * is already rendered on the page. it never renders settings itself, so
 * there is no duplication of controls, dialogs, or import/export flows.
 */
const SETTINGS_INDEX: SettingSearchEntry[] = [
    // Account and sync, then Appearance and privacy
    {
        id: 'sync-identity',
        page: 'account-sync',
        title: 'Sync Identity',
        description: 'Cloud account profile: display name, avatar, UUID, push to cloud and pull from cloud.',
        keywords: ['account', 'cloud', 'login', 'name', 'avatar', 'uuid', 'identity', 'push', 'pull', 'profile'],
    },
    {
        id: 'about',
        page: 'account-sync',
        title: 'About',
        description: 'Version and build information for this installation.',
        keywords: ['version', 'build', 'release', 'commit', 'about', 'changelog'],
    },
    {
        id: 'install-app',
        page: 'appearance-privacy',
        title: 'Install App',
        description: 'Add AIOManager to your device for an app-like window.',
        keywords: ['install', 'app', 'pwa', 'desktop', 'standalone', 'progressive web app', 'installable'],
    },
    {
        id: 'privacy-mode',
        page: 'appearance-privacy',
        title: 'Privacy Mode',
        description: 'Control how sensitive data appears, with granular masking for account names, addon URLs, profile names and email.',
        keywords: ['privacy', 'mask', 'hide', 'redact', 'sensitive', 'blur', 'obfuscate', 'names', 'urls', 'email', 'incognito'],
    },
    // Appearance and privacy
    {
        id: 'themes',
        page: 'appearance-privacy',
        title: 'Appearance & Themes',
        description: 'Pick a light, dark or OLED theme, each with its own accent colors.',
        keywords: ['theme', 'dark mode', 'light mode', 'oled', 'appearance', 'accent', 'color', 'background', 'look'],
    },
    {
        id: 'custom-themes',
        page: 'appearance-privacy',
        title: 'Custom Themes',
        description: 'Create, paste, import, edit, clone, copy and download your own themes.',
        keywords: ['custom theme', 'create theme', 'paste theme', 'import theme', 'share theme', 'theme json', 'editor', 'design'],
        anchor: 'themes',
        heading: 'Custom Themes',
    },
    // Account and sync, keys, updates and activity
    {
        id: 'backup-restore',
        page: 'account-sync',
        title: 'Backup & Restore',
        description: 'Export your entire configuration (accounts, profiles, addons, rules) to a portable JSON file, or import a backup.',
        keywords: ['backup', 'export', 'import', 'restore', 'json', 'download', 'upload', 'transfer', 'migrate', 'syncio'],
    },
    {
        id: 'metadata-integrations',
        page: 'keys',
        title: 'Metadata Integrations',
        description: 'Provider API keys for TMDB, PMDB, MDBList and TVDB metadata enrichment.',
        keywords: ['metadata', 'integration', 'provider', 'tmdb', 'pmdb', 'mdblist', 'tvdb', 'trailers', 'recommendations', 'ratings'],
    },
    {
        id: 'api-keys',
        page: 'keys',
        title: 'API Keys',
        description: 'Manage per-account API keys and credentials.',
        keywords: ['api', 'key', 'keys', 'credentials', 'token', 'auth', 'secret'],
    },
    {
        id: 'auto-update',
        page: 'updates-activity',
        title: 'Auto-update',
        description: 'Install newer addon versions automatically: interval, platforms and per-account exclusions.',
        keywords: ['auto update', 'auto-update', 'autoupdate', 'update', 'upgrade', 'version', 'outdated', 'interval', 'reinstall', 'addons'],
    },
    {
        id: 'sync-connections',
        page: 'account-sync',
        title: 'Active Sync Connections',
        description: 'Saved addons that mirror into installed account addons.',
        keywords: ['sync', 'connections', 'mirror', 'mirroring', 'active sync', 'addon sync'],
    },
    {
        id: 'history-cache',
        page: 'updates-activity',
        title: 'Clear History Cache',
        description: 'Wipe locally cached activity view data and watch event history.',
        keywords: ['clear', 'cache', 'history', 'activity', 'watch', 'wipe', 're-pull', 'events'],
    },
    {
        id: 'live-activity',
        page: 'updates-activity',
        title: 'Live Activity Refresh',
        description: 'Auto-refresh Activity page progress every 60 seconds.',
        keywords: ['live', 'activity', 'refresh', 'auto', 'interval', 'auto-refresh', 'rate limit'],
    },
    // Updates and activity, devices and maintenance pages
    {
        id: 'monitoring-alerts',
        page: 'updates-activity',
        title: 'Monitoring & Alerts',
        description: 'Autopilot webhook alerts.',
        keywords: ['notifications', 'alerts', 'monitoring', 'webhook', 'webhooks', 'autopilot', 'notify'],
    },
    {
        id: 'repair-recovery',
        page: 'devices-maintenance',
        title: 'Repair & Recovery',
        description: 'Repair all accounts, re-authenticate expired accounts, re-check connections and copy diagnostics.',
        keywords: ['repair', 'recovery', 'fix', 're-authenticate', 'reauth', 'expired', 're-check', 'diagnostics', 'troubleshoot', 'broken', 'unknown addon'],
    },
    {
        id: 'remembered-devices',
        page: 'devices-maintenance',
        title: 'Remembered Devices',
        description: 'Devices remembered for cloud sync authentication.',
        keywords: ['remembered', 'devices', 'device', 'trusted', 'login devices', 'sessions'],
    },
    {
        id: 'sync-diagnostics',
        page: 'devices-maintenance',
        title: 'Cloud Sync Diagnostics',
        description: 'Sync history logs plus manual push and pull overrides.',
        keywords: ['sync diagnostics', 'sync events', 'logs', 'force push', 'force pull', 'override', 'cloud sync', 'history logs'],
    },
    {
        id: 'danger-zone',
        page: 'danger-zone',
        title: 'Danger Zone',
        description: 'Irreversible actions that permanently delete data. Requires unlocking first.',
        keywords: ['danger', 'delete', 'reset', 'wipe', 'destructive', 'unsafe', 'irreversible', 'erase', 'delete all'],
    },
]

const normalize = (value: string) => value.toLowerCase().trim().replace(/\s+/g, ' ')

/**
 * Rank and filter the settings index against a free-text query.
 * Every whitespace-separated word must match somewhere (title, description
 * or keywords); results are ranked title > keyword > description matches.
 */
export function searchSettings(query: string, limit = 8): SettingSearchMatch[] {
    const q = normalize(query)
    if (!q) return []
    const words = q.split(' ').filter(Boolean)
    if (words.length === 0) return []

    const matches: (SettingSearchMatch & { score: number })[] = []
    for (const entry of SETTINGS_INDEX) {
        const title = normalize(entry.title)
        const description = normalize(entry.description)
        const keywords = entry.keywords.map(normalize)
        const haystack = `${title} ${description} ${keywords.join(' ')}`
        if (!words.every(word => haystack.includes(word))) continue

        let score = 0
        if (title === q) score += 100
        else if (title.startsWith(q)) score += 60
        else if (title.includes(q)) score += 40
        else if (words.every(word => title.includes(word))) score += 25

        if (keywords.some(keyword => keyword === q)) score += 30
        else if (keywords.some(keyword => keyword.startsWith(q) || q.startsWith(keyword))) score += 15

        if (description.includes(q)) score += 8

        const matchedKeywords = entry.keywords.filter(keyword =>
            words.some(word => normalize(keyword).includes(word))
        )
        matches.push({ entry, matchedKeywords, score })
    }

    return matches
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ entry, matchedKeywords }) => ({ entry, matchedKeywords }))
}

/**
 * Resolve the rendered DOM target for a search destination.
 * Looks up the wrapper marked with `data-settings-anchor` on the settings
 * page and, when a heading is provided, drills into the exact inner heading
 * so the scroll lands on the precise sub-section.
 */
export function resolveSectionElement(anchor: string, heading?: string): HTMLElement | null {
    const anchorEl = document.querySelector<HTMLElement>(`[data-settings-anchor="${anchor}"]`)
    if (!anchorEl) return null
    if (heading) {
        const wanted = normalize(heading)
        const headings = anchorEl.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5')
        for (const el of headings) {
            if (normalize(el.textContent || '').includes(wanted)) return el
        }
    }
    return anchorEl
}

interface SettingsSearchProps {
    onNavigate: (entry: SettingSearchEntry) => void
    /** Mirrors the raw query so the home list can filter its rows live. */
    onQueryChange?: (query: string) => void
    className?: string
    /** Extra classes for the results popover: desktop anchors right and grows left over the tab strip. */
    popoverClassName?: string
    /** Compact toolbar style (h32, r10, text-xs, bg-muted/30) used inside the section bar. */
    compact?: boolean
}

/**
 * Small "Find a setting" search that jumps to an EXISTING settings section
 * and its containing page. It never renders settings itself.
 */
export function SettingsSearch({ onNavigate, onQueryChange, className, popoverClassName, compact }: SettingsSearchProps) {
    const [installable, setInstallable] = useState(canInstall())
    const [query, setQuery] = useState('')
    const [open, setOpen] = useState(false)
    const [activeIndex, setActiveIndex] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLUListElement>(null)

    useEffect(() => subscribeInstall(setInstallable), [])
    const results = useMemo(() => searchSettings(query, SETTINGS_INDEX.length)
        .filter(match => installable || match.entry.id !== 'install-app').slice(0, 8), [query, installable])
    const showResults = open && normalize(query).length > 0

    useEffect(() => {
        setActiveIndex(0)
    }, [query])

    useEffect(() => {
        if (!showResults) return
        listRef.current
            ?.querySelector(`[data-option-index="${activeIndex}"]`)
            ?.scrollIntoView({ block: 'nearest' })
    }, [activeIndex, showResults])

    const select = (match: SettingSearchMatch) => {
        onNavigate(match.entry)
        setQuery('')
        onQueryChange?.('')
        setOpen(false)
        inputRef.current?.blur()
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (results.length === 0) return
            e.preventDefault()
            setOpen(true)
            setActiveIndex(i => {
                const count = results.length
                const delta = e.key === 'ArrowDown' ? 1 : -1
                return (i + delta + count) % count
            })
        } else if (e.key === 'Enter') {
            const match = results[activeIndex] ?? results[0]
            if (match) {
                e.preventDefault()
                select(match)
            }
        } else if (e.key === 'Escape') {
            e.preventDefault()
            if (query) {
                setQuery('')
                onQueryChange?.('')
            } else {
                inputRef.current?.blur()
            }
        }
    }

    return (
        <div className={cn('relative min-w-0', compact && 'text-xs', className)}>
            <Search className={cn('pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70', compact && 'h-3.5 w-3.5')} />
            <Input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => {
                    setQuery(e.target.value)
                    onQueryChange?.(e.target.value)
                    setOpen(true)
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={handleKeyDown}
                placeholder="Find a setting..."
                aria-label="Find a setting"
                role="combobox"
                aria-expanded={showResults}
                aria-controls="settings-search-listbox"
                aria-autocomplete="list"
                aria-activedescendant={showResults && results[activeIndex] ? `settings-search-option-${results[activeIndex].entry.id}` : undefined}
                className={compact ? 'h-8 rounded-lg border-border/40 bg-muted/30 pl-9 pr-8 text-xs' : 'h-9 rounded-2xl border-border/45 bg-card pl-9 pr-9 text-sm shadow-sm'}
            />
            {query && (
                <button
                    type="button"
                    data-theme-part="button"
                    aria-label="Clear search"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                        setQuery('')
                        onQueryChange?.('')
                        inputRef.current?.focus()
                    }}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            )}
            {showResults && (
                <div data-theme-part="popover" className={cn('absolute top-[calc(100%+0.5rem)] z-50 left-0 right-0 overflow-hidden rounded-2xl border border-border/50 bg-card shadow-lg', popoverClassName)}>
                    {results.length === 0 ? (
                        <p className="px-4 py-3 text-xs text-muted-foreground">
                            No settings match <span className="font-medium text-foreground">"{query.trim()}"</span>
                        </p>
                    ) : (
                        <ul
                            ref={listRef}
                            id="settings-search-listbox"
                            role="listbox"
                            aria-label="Matching settings sections"
                            className="max-h-80 overflow-y-auto py-1.5 custom-scrollbar"
                        >
                            {results.map((match, index) => {
                                const isActive = index === activeIndex
                                return (
                                    <li
                                        key={match.entry.id}
                                        id={`settings-search-option-${match.entry.id}`}
                                        role="option"
                                        aria-selected={isActive}
                                        data-option-index={index}
                                        data-theme-part="menu-item"
                                        onMouseMove={() => setActiveIndex(index)}
                                        onMouseDown={e => e.preventDefault()}
                                        onClick={() => select(match)}
                                        className={cn(
                                            'mx-1.5 flex cursor-pointer flex-col gap-1 rounded-xl px-3 py-2.5 transition-colors',
                                            isActive ? 'bg-primary/10' : 'hover:bg-muted/40'
                                        )}
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="min-w-0 truncate text-sm font-medium text-foreground">
                                                <HighlightText text={match.entry.title} highlight={query} />
                                            </span>
                                            <span data-theme-part="badge" className="shrink-0 rounded-full border border-border/40 bg-muted/30 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                                {SETTING_PAGE_LABELS[match.entry.page]}
                                            </span>
                                        </div>
                                        <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                                            <HighlightText text={match.entry.description} highlight={query} />
                                        </span>
                                        {match.matchedKeywords.length > 0 && (
                                            <span className="flex flex-wrap items-center gap-1">
                                                {match.matchedKeywords.slice(0, 3).map(keyword => (
                                                    <span
                                                        key={keyword}
                                                        data-theme-part="badge"
                                                        className="rounded-md bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground"
                                                    >
                                                        {keyword}
                                                    </span>
                                                ))}
                                            </span>
                                        )}
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                    <p className="border-t border-border/30 px-3.5 py-1.5 text-xs text-muted-foreground/60">
                        ↑↓ browse · Enter jumps to the section · Esc clears
                    </p>
                </div>
            )}
        </div>
    )
}
