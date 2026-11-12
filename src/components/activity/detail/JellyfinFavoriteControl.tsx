import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Heart, Loader2, Minus, RefreshCw, Search, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/contexts/ThemeContext'
import { useUIStore } from '@/store/uiStore'
import { useAuthStore } from '@/store/authStore'
import { decrypt } from '@/lib/crypto'
import { Button } from '@/components/ui/button'
import { AccountAvatar as AccountSwitcherAvatar, maskedDisplayName } from '@/components/common/AccountSwitcher'
import { readJellyfinFavorite, writeJellyfinFavorite, favoriteLookupSignature } from '@/lib/jellyfin/favorites'
import { getActiveWorkspaceId, subscribeWorkspaceChanges } from '@/lib/workspace-persistence'
import { accountMatchesQuery } from '@/lib/account-compat'
import type { Account } from '@/types/account'
import type { Connection } from '@/types/connection'

// Async ops are tagged per title, subject and connection: a late response never touches another title's state.

export interface JellyfinFavoritePerson {
    account: Account
    connections: Connection[]
}

interface JellyfinFavoriteControlProps {
    open: boolean
    people: JellyfinFavoritePerson[]
    canonicalIds: string[]
    series: boolean
}

type RetryPlan = { kind: 'lookup' } | { kind: 'write'; itemId: string; favorite: boolean }

type Phase =
    | { kind: 'loading' }
    | { kind: 'idle'; favorite: boolean; itemId: string }
    | { kind: 'working'; favorite: boolean; itemId: string }
    | { kind: 'working-lookup' }
    | { kind: 'failed'; retry: RetryPlan }
    | { kind: 'absent' }

type HeartState = 'full' | 'half' | 'empty'

interface PersonView {
    person: JellyfinFavoritePerson
    items: Array<{ conn: Connection; phase: Phase }>
    busy: boolean
    failed: Array<{ conn: Connection; phase: { kind: 'failed'; retry: RetryPlan } }>
    heart: HeartState
    allAbsent: boolean
}

const HEART_FILL = 'hsl(348 77% 52%)'
const LOOKUP_SETTLE_MS = 300

export function JellyfinFavoriteControl({ open, people, canonicalIds, series }: JellyfinFavoriteControlProps) {
    const { isLight } = useTheme()
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const privacyLevelEmail = useUIStore(s => s.privacyLevelEmail)
    const privacyLevel = isPrivacyModeEnabled ? privacyLevelNames : 0
    const emailPrivacy = isPrivacyModeEnabled ? privacyLevelEmail : 0
    const workspaceId = useSyncExternalStore(subscribeWorkspaceChanges, getActiveWorkspaceId, () => '')

    const [phases, setPhases] = useState<Record<string, Phase>>({})
    const [menuOpen, setMenuOpen] = useState(false)
    const [search, setSearch] = useState('')
    const [dropdownPos, setDropdownPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const searchRef = useRef<HTMLInputElement>(null)
    const dropdownRef = useRef<HTMLDivElement>(null)
    const lookupControllerRef = useRef<AbortController | null>(null)
    const lookupTimerRef = useRef<number | null>(null)
    const lastLookupRef = useRef<string | null>(null)
    const opControllersRef = useRef<Map<string, AbortController>>(new Map())
    const mountedRef = useRef(false)
    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            if (lookupTimerRef.current !== null) window.clearTimeout(lookupTimerRef.current)
            lookupControllerRef.current?.abort()
            // eslint-disable-next-line react-hooks/exhaustive-deps
            for (const controller of opControllersRef.current.values()) controller.abort()
            opControllersRef.current.clear()
        }
    }, [])

    const generation = useMemo(() => `${canonicalIds.join(',')}|${series ? 's' : 'm'}`, [canonicalIds, series])
    const generationRef = useRef(generation)
    generationRef.current = generation
    const connections = useMemo(() => people.flatMap(entry => entry.connections), [people])
    const subjects = useMemo(
        () => new Map(connections.map(conn => [
            conn.id,
            `${conn.id}|${workspaceId}|${conn.credentials?.jellyfin ?? ''}|${conn.mediaServer?.serverId ?? ''}|${conn.mediaServer?.userId ?? ''}`,
        ])),
        [connections, workspaceId],
    )
    const subjectsRef = useRef(subjects)
    subjectsRef.current = subjects
    const lastSubjectsRef = useRef<Map<string, string>>(new Map())
    const epochsRef = useRef<Map<string, number>>(new Map())
    const opGenerationFor = (id: string): string => `${generationRef.current}|${subjectsRef.current.get(id) ?? ''}|${epochsRef.current.get(id) ?? 0}`

    const setPhase = (id: string, phase: Phase, atGeneration: string = opGenerationFor(id)) => {
        if (!mountedRef.current || opGenerationFor(id) !== atGeneration) return
        setPhases(prev => ({ ...prev, [id]: phase }))
    }

    // A removed or re-identified connection gets a new epoch, so its in-flight operations can never become current again.
    useEffect(() => {
        for (const [id, previous] of lastSubjectsRef.current) {
            if (subjects.get(id) === previous) continue
            opControllersRef.current.get(id)?.abort()
            opControllersRef.current.delete(id)
            epochsRef.current.set(id, (epochsRef.current.get(id) ?? 0) + 1)
        }
        lastSubjectsRef.current = subjects
    }, [subjects])

    const displayLabel = (conn: Connection) =>
        conn.mediaServer?.productName || conn.displayName || 'Jellyfin'

    const settledFavorite = (phase: Phase): boolean | null => {
        if (phase.kind === 'idle') return phase.favorite
        if (phase.kind === 'failed' && phase.retry.kind === 'write') return !phase.retry.favorite
        if (phase.kind === 'failed') return false
        return null
    }

    const personViews = useMemo<PersonView[]>(() => people.map(person => {
        const items = person.connections.map(conn => ({ conn, phase: phases[conn.id] ?? { kind: 'loading' as const } }))
        const busy = items.some(({ phase }) => phase.kind === 'loading' || phase.kind === 'working' || phase.kind === 'working-lookup')
        const failed = items.flatMap(({ conn, phase }) => phase.kind === 'failed' ? [{ conn, phase }] : [])
        const counted = items.map(({ conn, phase }) => ({ conn, favorite: settledFavorite(phase) })).filter(entry => entry.favorite !== null) as Array<{ conn: Connection; favorite: boolean }>
        const favorites = counted.filter(entry => entry.favorite).length
        const heart: HeartState = counted.length > 0 && favorites === counted.length ? 'full' : favorites > 0 ? 'half' : 'empty'
        return { person, items, busy, failed, heart, allAbsent: items.length > 0 && items.every(({ phase }) => phase.kind === 'absent') }
    }), [people, phases])

    const everyone = useMemo(() => {
        const listed = personViews.filter(view => !view.allAbsent)
        const full = listed.length > 0 && listed.every(view => view.heart === 'full')
        const empty = listed.every(view => view.heart === 'empty')
        return { busy: personViews.some(view => view.busy), heart: (full ? 'full' : empty ? 'empty' : 'half') as HeartState, full }
    }, [personViews])

    const entries = useMemo(
        () => connections.map(conn => ({ conn, phase: phases[conn.id] ?? { kind: 'loading' as const } })),
        [connections, phases],
    )
    const single = people.length === 1
    const singleView = personViews[0]
    const singleWorking = single && singleView?.busy
    const allAbsent = entries.length > 0 && entries.every(entry => entry.phase.kind === 'absent')
    const disabled = allAbsent && !singleWorking
    const faved = !singleWorking && !disabled && entries.some(entry => entry.phase.kind === 'idle' && entry.phase.favorite)
    const singleFailed = single && singleView !== undefined && singleView.failed.length > 0
    const hidden = people.length === 0 || canonicalIds.length === 0
    const busyAny = entries.some(entry => entry.phase.kind === 'loading' || entry.phase.kind === 'working' || entry.phase.kind === 'working-lookup')

    const personTargets = (view: PersonView, desired: boolean): Array<{ conn: Connection; itemId: string; favorite: boolean }> => {
        const targets: Array<{ conn: Connection; itemId: string; favorite: boolean }> = []
        for (const { conn, phase } of view.items) {
            if (phase.kind === 'idle' && phase.favorite !== desired) targets.push({ conn, itemId: phase.itemId, favorite: desired })
            else if (phase.kind === 'failed' && phase.retry.kind === 'write' && phase.retry.favorite !== desired) targets.push({ conn, itemId: phase.retry.itemId, favorite: desired })
        }
        return targets
    }

    const runLookups = (targets: Connection[], signal: AbortSignal) => {
        const key = useAuthStore.getState().encryptionKey
        if (!key) {
            for (const conn of targets) setPhase(conn.id, { kind: 'failed', retry: { kind: 'lookup' } })
            return
        }
        const openCipher = (value: string) => decrypt(value, key)
        for (const conn of targets) {
            const atGeneration = opGenerationFor(conn.id)
            readJellyfinFavorite(conn, openCipher, { canonicalIds, series }, signal, workspaceId)
                .then(status => {
                    if (signal.aborted || opGenerationFor(conn.id) !== atGeneration) return
                    setPhase(conn.id, status.state === 'found'
                        ? { kind: 'idle', favorite: status.favorite, itemId: status.itemId }
                        : { kind: 'absent' }, atGeneration)
                })
                .catch(error => {
                    if (signal.aborted || opGenerationFor(conn.id) !== atGeneration) return
                    console.warn('Jellyfin favorite lookup failed', error)
                    setPhase(conn.id, { kind: 'failed', retry: { kind: 'lookup' } }, atGeneration)
                })
        }
    }

    useEffect(() => {
        if (!open || connections.length === 0 || canonicalIds.length === 0) {
            lastLookupRef.current = null
            if (lookupTimerRef.current !== null) window.clearTimeout(lookupTimerRef.current)
            lookupTimerRef.current = null
            lookupControllerRef.current?.abort()
            lookupControllerRef.current = null
            setPhases({})
            return
        }
        const signature = favoriteLookupSignature(connections, { canonicalIds, series }, [open ? '1' : '0', workspaceId])
        const inFlight = lookupControllerRef.current !== null && !lookupControllerRef.current.signal.aborted
        if (lastLookupRef.current === signature && inFlight) return
        lastLookupRef.current = signature
        lookupControllerRef.current?.abort()
        const controller = new AbortController()
        lookupControllerRef.current = controller
        setPhases(Object.fromEntries(connections.map(conn => [conn.id, { kind: 'loading' } as Phase])))
        if (lookupTimerRef.current !== null) window.clearTimeout(lookupTimerRef.current)
        lookupTimerRef.current = window.setTimeout(() => {
            lookupTimerRef.current = null
            if (!controller.signal.aborted) runLookups(connections, controller.signal)
        }, LOOKUP_SETTLE_MS)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, connections, canonicalIds, series, workspaceId])

    const ownOperation = (conn: Connection): AbortController => {
        opControllersRef.current.get(conn.id)?.abort()
        const controller = new AbortController()
        opControllersRef.current.set(conn.id, controller)
        return controller
    }

    const settleFromServer = (conn: Connection, atGeneration: string) => {
        const key = useAuthStore.getState().encryptionKey
        if (!key) return
        const controller = ownOperation(conn)
        readJellyfinFavorite(conn, value => decrypt(value, key), { canonicalIds, series }, controller.signal, workspaceId)
            .then(status => {
                if (controller.signal.aborted || opGenerationFor(conn.id) !== atGeneration) return
                setPhase(conn.id, status.state === 'found'
                    ? { kind: 'idle', favorite: status.favorite, itemId: status.itemId }
                    : { kind: 'absent' }, atGeneration)
            })
            .catch(error => {
                if (controller.signal.aborted || opGenerationFor(conn.id) !== atGeneration) return
                console.warn('Jellyfin favorite lookup failed', error)
                setPhase(conn.id, { kind: 'failed', retry: { kind: 'lookup' } }, atGeneration)
            })
    }

    const runWrite = (conn: Connection, itemId: string, favorite: boolean) => {
        const atGeneration = opGenerationFor(conn.id)
        const controller = ownOperation(conn)
        const key = useAuthStore.getState().encryptionKey
        if (!key) {
            setPhase(conn.id, { kind: 'failed', retry: { kind: 'write', itemId, favorite } }, atGeneration)
            return
        }
        setPhase(conn.id, { kind: 'working', favorite, itemId }, atGeneration)
        writeJellyfinFavorite(conn, value => decrypt(value, key), itemId, favorite, controller.signal, workspaceId)
            .then(() => {
                if (controller.signal.aborted || opGenerationFor(conn.id) !== atGeneration) return
                setPhase(conn.id, { kind: 'idle', favorite, itemId }, atGeneration)
            })
            .catch(error => {
                if (controller.signal.aborted) {
                    if (opControllersRef.current.get(conn.id) === controller && opGenerationFor(conn.id) === atGeneration && mountedRef.current) {
                        settleFromServer(conn, atGeneration)
                    }
                    return
                }
                if (opGenerationFor(conn.id) !== atGeneration) return
                console.warn('Jellyfin favorite write failed', error)
                setPhase(conn.id, { kind: 'failed', retry: { kind: 'write', itemId, favorite } }, atGeneration)
            })
    }

    const runRetry = (conn: Connection, plan: RetryPlan) => {
        if (plan.kind === 'write') {
            runWrite(conn, plan.itemId, plan.favorite)
            return
        }
        const atGeneration = opGenerationFor(conn.id)
        const key = useAuthStore.getState().encryptionKey
        if (!key) {
            setPhase(conn.id, { kind: 'failed', retry: { kind: 'lookup' } }, atGeneration)
            return
        }
        const controller = ownOperation(conn)
        setPhase(conn.id, { kind: 'working-lookup' }, atGeneration)
        readJellyfinFavorite(conn, value => decrypt(value, key), { canonicalIds, series }, controller.signal, workspaceId)
            .then(status => {
                if (controller.signal.aborted || opGenerationFor(conn.id) !== atGeneration) return
                setPhase(conn.id, status.state === 'found'
                    ? { kind: 'idle', favorite: status.favorite, itemId: status.itemId }
                    : { kind: 'absent' }, atGeneration)
            })
            .catch(error => {
                if (controller.signal.aborted || opGenerationFor(conn.id) !== atGeneration) return
                console.warn('Jellyfin favorite lookup failed', error)
                setPhase(conn.id, { kind: 'failed', retry: { kind: 'lookup' } }, atGeneration)
            })
    }

    const personTap = (view: PersonView) => {
        if (view.busy || view.allAbsent) return
        const desired = view.heart !== 'full'
        for (const target of personTargets(view, desired)) runWrite(target.conn, target.itemId, target.favorite)
    }

    const everyoneTap = () => {
        if (everyone.busy) return
        const desired = !everyone.full
        for (const view of personViews) {
            if (view.allAbsent) continue
            for (const target of personTargets(view, desired)) runWrite(target.conn, target.itemId, target.favorite)
        }
    }

    const onHeartClick = () => {
        if (hidden || disabled) return
        if (single) {
            if (!singleView || singleView.busy) return
            if (singleView.failed.length > 0) {
                for (const failed of singleView.failed) runRetry(failed.conn, failed.phase.retry)
                return
            }
            const desired = singleView.heart !== 'full'
            for (const target of personTargets(singleView, desired)) runWrite(target.conn, target.itemId, target.favorite)
            return
        }
        setMenuOpen(openState => !openState)
    }

    // A menu that cannot render must not stay open: its capture listener would keep eating Escape.
    useEffect(() => {
        if (single || hidden) setMenuOpen(false)
    }, [single, hidden])

    useEffect(() => {
        if (!menuOpen) {
            setDropdownPos(null)
            return
        }
        setSearch('')
        setTimeout(() => searchRef.current?.focus(), 0)
        const updatePos = () => {
            if (!buttonRef.current) return
            const rect = buttonRef.current.getBoundingClientRect()
            const view = window.visualViewport
            const viewTop = view?.offsetTop ?? 0
            const viewLeft = view?.offsetLeft ?? 0
            const viewBottom = viewTop + (view?.height ?? window.innerHeight)
            const viewRight = viewLeft + (view?.width ?? window.innerWidth)
            const anchorTop = Math.max(viewTop, Math.min(rect.top, viewBottom))
            const anchorBottom = Math.max(anchorTop, Math.min(rect.bottom, viewBottom))
            const width = Math.max(0, Math.min(Math.max(rect.width, 280), viewRight - viewLeft - 16))
            const left = Math.max(viewLeft + 8, Math.min(rect.left, viewRight - width - 8))
            const spaceBelow = viewBottom - anchorBottom - 12
            const spaceAbove = anchorTop - viewTop - 12
            if (spaceBelow >= spaceAbove) {
                setDropdownPos({ top: anchorBottom + 4, left, width, maxHeight: Math.min(400, Math.max(0, spaceBelow)) })
                return
            }
            setDropdownPos({ bottom: window.innerHeight - anchorTop + 4, left, width, maxHeight: Math.min(400, Math.max(0, spaceAbove)) })
        }
        updatePos()
        window.addEventListener('resize', updatePos)
        window.addEventListener('scroll', updatePos, true)
        window.visualViewport?.addEventListener('resize', updatePos)
        window.visualViewport?.addEventListener('scroll', updatePos)
        return () => {
            window.removeEventListener('resize', updatePos)
            window.removeEventListener('scroll', updatePos, true)
            window.visualViewport?.removeEventListener('resize', updatePos)
            window.visualViewport?.removeEventListener('scroll', updatePos)
        }
    }, [menuOpen])

    useEffect(() => {
        if (!menuOpen) return
        const handler = (e: MouseEvent) => {
            if (
                containerRef.current && !containerRef.current.contains(e.target as Node) &&
                (!dropdownRef.current || !dropdownRef.current.contains(e.target as Node))
            ) {
                setMenuOpen(false)
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [menuOpen])

    // Window capture: the menu consumes Escape before the modal can see it.
    useEffect(() => {
        if (!menuOpen) return
        const handler = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            setMenuOpen(false)
            buttonRef.current?.focus()
        }
        window.addEventListener('keydown', handler, true)
        return () => window.removeEventListener('keydown', handler, true)
    }, [menuOpen])

    const menuFocusables = (): HTMLElement[] => {
        const root = dropdownRef.current
        if (!root) return []
        return Array.from(root.querySelectorAll<HTMLElement>('[data-menu-search], [data-menu-row], [data-retry-for]'))
            .filter(el => !(el instanceof HTMLButtonElement && el.disabled))
    }

    const onDropdownKeyDown = (e: { key: string; shiftKey?: boolean; preventDefault: () => void }) => {
        if (e.key === 'Tab') {
            e.preventDefault()
            const nodes = menuFocusables()
            const index = nodes.findIndex(el => el === document.activeElement)
            const inside = nodes.length > 0 && (e.shiftKey ? index > 0 : index !== -1 && index < nodes.length - 1)
            if (inside) {
                nodes[e.shiftKey ? index - 1 : index + 1]?.focus()
                return
            }
            setMenuOpen(false)
            buttonRef.current?.focus()
            return
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        const nodes = menuFocusables()
        if (nodes.length === 0) return
        const index = nodes.findIndex(el => el === document.activeElement)
        const next = e.key === 'ArrowDown' ? (index + 1 + nodes.length) % nodes.length : (index - 1 + nodes.length) % nodes.length
        nodes[next]?.focus()
    }

    const heartGlyph = (state: HeartState, dimmed: boolean) => {
        if (state === 'full') return <Heart className="h-3.5 w-3.5 shrink-0" fill={HEART_FILL} stroke={HEART_FILL} />
        if (state === 'half') {
            return (
                <span className="relative inline-block h-3.5 w-3.5 shrink-0">
                    <Heart className={cn('absolute inset-0 h-3.5 w-3.5', dimmed ? 'text-muted-foreground/60' : 'text-muted-foreground')} />
                    <Heart className="absolute inset-0 h-3.5 w-3.5" fill={HEART_FILL} stroke={HEART_FILL} style={{ clipPath: 'inset(0 50% 0 0)' }} />
                </span>
            )
        }
        return <Heart className={cn('h-3.5 w-3.5 shrink-0', dimmed ? 'text-muted-foreground/60' : 'text-muted-foreground')} />
    }

    const rowTint = (selected: boolean) =>
        selected ? 'bg-primary/12 text-primary border border-primary/25' : 'border border-transparent hover:bg-muted/50'

    const personRow = (view: PersonView) => {
        const { person } = view
        const maskedName = maskedDisplayName(person.account.name, person.account.email, privacyLevel, emailPrivacy)
        const selected = view.heart === 'full' && !view.busy
        const labels = [...new Set(person.connections.map(displayLabel))]
        const firstFailed = view.failed[0]
        const retryRow = view.failed.length > 0 && !view.busy
            ? (
                <button
                    type="button"
                    data-retry-for={person.account.id}
                    onClick={e => {
                        // Isolated from the row toggle: the row would invert the failed write's intent.
                        e.stopPropagation()
                        if (document.activeElement === e.currentTarget) e.currentTarget.closest<HTMLElement>('[data-menu-row]')?.focus()
                        for (const failed of view.failed) runRetry(failed.conn, failed.phase.retry)
                    }}
                    onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/40 px-2 py-1 text-[10px] font-bold text-destructive transition-colors hover:bg-destructive/15"
                >
                    <RefreshCw className="h-3 w-3" />
                    Retry
                </button>
            )
            : null
        const line = firstFailed !== undefined
            ? <span className="text-left text-[10px] leading-snug text-destructive">Couldn't update {displayLabel(firstFailed.conn)}. Try again.</span>
            : view.allAbsent
                ? <span className="text-left text-[10px] text-muted-foreground">{person.connections.length === 1 ? 'Not on this server' : 'Not on their servers'}</span>
                : <span className="text-left text-[10px] text-muted-foreground">{labels.join(', ')}</span>
        return (
            <div
                key={person.account.id}
                data-menu-row=""
                data-account-id={person.account.id}
                data-heart-state={view.busy ? 'working' : view.heart}
                data-absent={view.allAbsent ? 'true' : undefined}
                role="menuitemcheckbox"
                aria-checked={view.heart === 'full' ? 'true' : view.heart === 'half' ? 'mixed' : 'false'}
                aria-disabled={view.busy || view.allAbsent ? 'true' : undefined}
                tabIndex={view.busy || view.allAbsent ? -1 : 0}
                onClick={() => personTap(view)}
                onKeyDown={e => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    if (view.failed.length > 0 && !view.busy) {
                        for (const failed of view.failed) runRetry(failed.conn, failed.phase.retry)
                        return
                    }
                    personTap(view)
                }}
                className={cn(
                    'flex min-h-[46px] w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors',
                    !view.busy && !view.allAbsent && rowTint(selected),
                    (view.busy || view.allAbsent) && 'cursor-default border border-transparent opacity-70',
                )}
            >
                <AccountSwitcherAvatar account={{ ...person.account, name: maskedName }} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={cn('truncate text-left text-xs font-medium', selected && 'text-primary')}>{maskedName || 'Unknown Account'}</span>
                    {line}
                </span>
                {view.busy
                    ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                    : view.allAbsent
                        ? <Minus className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                        : heartGlyph(view.heart, false)}
                {retryRow}
            </div>
        )
    }

    const filtered = useMemo(() => {
        if (!search.trim()) return personViews
        return personViews.filter(view => accountMatchesQuery(view.person.account, search))
    }, [personViews, search])

    const dropdown = menuOpen && dropdownPos && !single ? createPortal(
        <div
            ref={dropdownRef}
            data-theme-part="popover"
            role="menu"
            aria-label="Jellyfin favorites"
            style={{ position: 'fixed', ...(dropdownPos.bottom !== undefined ? { bottom: dropdownPos.bottom } : { top: dropdownPos.top }), left: dropdownPos.left, width: dropdownPos.width, maxHeight: dropdownPos.maxHeight, zIndex: 100 }}
            onKeyDown={onDropdownKeyDown}
            className="flex flex-col bg-card border border-border/40 rounded-2xl shadow-lg overflow-hidden"
        >
            <div className="shrink-0 border-b border-border/40 p-2">
                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <input
                        ref={searchRef}
                        data-menu-search=""
                        data-theme-part="input"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search accounts..."
                        aria-label="Search people"
                        className="w-full h-8 pl-8 pr-3 text-xs bg-muted/30 border border-border/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/30"
                    />
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
                <div
                    data-menu-row=""
                    data-heart-state={everyone.busy ? 'working' : everyone.heart}
                    role="menuitemcheckbox"
                    aria-checked={everyone.heart === 'full' ? 'true' : everyone.heart === 'half' ? 'mixed' : 'false'}
                    aria-disabled={everyone.busy ? 'true' : undefined}
                    tabIndex={everyone.busy ? -1 : 0}
                    onClick={() => everyoneTap()}
                    onKeyDown={e => {
                        if (e.key !== 'Enter' && e.key !== ' ') return
                        e.preventDefault()
                        everyoneTap()
                    }}
                    className={cn(
                        'flex min-h-[44px] w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors',
                        !everyone.busy && rowTint(everyone.heart === 'full'),
                        everyone.busy && 'cursor-default border border-transparent',
                    )}
                >
                    <div className="w-6 h-6 rounded-full bg-muted/40 flex items-center justify-center shrink-0">
                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <span className="flex-1 text-left truncate font-semibold">Everyone</span>
                    {everyone.busy
                        ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                        : heartGlyph(everyone.heart, false)}
                </div>
                <div className="my-1 border-t border-border/40" />
                {filtered.length === 0 && (
                    <div className="px-3 py-4 text-xs text-muted-foreground text-center">No accounts found</div>
                )}
                {filtered.map(personRow)}
            </div>
        </div>,
        document.body
    ) : null

    const heartTone = isLight
        ? (faved
            ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow'
            : 'border border-border bg-card/80 text-foreground hover:bg-card')
        : (faved
            ? 'bg-white text-black hover:bg-white/90 shadow'
            : 'border border-white/20 bg-white/10 text-white hover:bg-white/20')

    const heartGlyphTrigger = singleWorking ? <Loader2 className="animate-spin" /> : <Heart {...(faved ? { fill: HEART_FILL, stroke: HEART_FILL } : {})} />
    const heartButton = (
        <Button
            ref={buttonRef}
            type="button"
            variant="ghost"
            data-theme-part="button"
            disabled={disabled}
            aria-label="Jellyfin favorite"
            aria-pressed={faved}
            aria-busy={busyAny || undefined}
            aria-haspopup="menu"
            aria-expanded={single ? undefined : menuOpen}
            onClick={onHeartClick}
            className={cn('h-11 w-11 rounded-full p-0 backdrop-blur-md [&_svg]:h-5 [&_svg]:w-5', heartTone)}
        >
            {heartGlyphTrigger}
        </Button>
    )

    if (hidden) return null

    return (
        <div ref={containerRef} className="relative inline-flex flex-none">
            {heartButton}
            {dropdown}
            {allAbsent && !singleFailed && (
                <div className="mt-2.5 flex w-full basis-full flex-wrap items-center gap-2.5">
                    <span className="text-xs text-muted-foreground">Not on your Jellyfin servers</span>
                </div>
            )}
            {singleFailed && singleView?.failed[0] !== undefined && (
                <div className="mt-2.5 flex w-full basis-full flex-wrap items-center gap-2.5">
                    <span className="text-xs font-medium text-destructive">Couldn't update {displayLabel(singleView.failed[0].conn)}. Try again.</span>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => { for (const failed of singleView.failed) runRetry(failed.conn, failed.phase.retry) }}
                        className="h-8 gap-1.5 rounded-full border-destructive/40 bg-transparent px-2.5 text-[11px] font-bold text-destructive shadow-none hover:bg-destructive/15 hover:text-destructive"
                    >
                        <RefreshCw className="h-3 w-3" />
                        Retry
                    </Button>
                </div>
            )}
        </div>
    )
}
