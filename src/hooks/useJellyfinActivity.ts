import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccountStore } from '@/store/accountStore'
import { useJellyfinMediaConnections, type JellyfinMediaOptions } from '@/components/providers/useJellyfinMedia'
import { compareMediaPlayback, createJellyfinActivityProjector, mediaDeletedAt, mergeMediaItems, mergeMediaHistory, type JellyfinActivityItem, type MediaPlayback } from '@/lib/jellyfin/activity'
import type { ActivityItem } from '@/types/activity'
import type { Account } from '@/types/account'
import { useWatchEventStore } from '@/store/watchEventStore'
import { getEpisodeIdentity } from '@/lib/activity-utils'
import { reuseActivityItems } from '@/lib/activity-structural-sharing'
import type { MediaReadCause } from '@/lib/jellyfin/reads'

export interface MediaReadIssue {
    accountId: string
    connectionId: string
    productName: string
    label: string
    message: string
    kind?: 'limit' | 'source-count'
    serverKey?: string
    cause?: MediaReadCause
}

function mediaServerKey(server: { product: string; serverId?: string; serverName?: string } | undefined, connectionId: string): string {
    if (server?.serverId) return `id:${server.serverId}`
    if (server?.serverName) return `name:${server.product}:${server.serverName}`
    return `conn:${connectionId}`
}

const NO_ACCOUNTS: Account[] = []
const NO_DELETED_EVENT_KEYS: ReturnType<typeof useWatchEventStore.getState>['deletedEventKeys'] = {}

export function useJellyfinActivity(accountId?: string, enabled = true, options: JellyfinMediaOptions = {}) {
    // Per-card subscriptions stay narrow: this account's own object plus its index
    // in the account list, instead of the entire accounts array. An unrelated
    // account store write (another card syncing, a note edit) then re-renders only
    // the card it changed, not the whole grid. The unscoped path (activity pages)
    // keeps the full-array subscription it always had.
    const ownAccount = useAccountStore(s => (enabled && accountId ? s.accounts.find(a => a.id === accountId) : undefined))
    const ownColorIndex = useAccountStore(s => (enabled && accountId ? s.accounts.findIndex(a => a.id === accountId) : 0))
    const allAccounts = useAccountStore(s => (enabled && !accountId ? s.accounts : undefined))
    const accounts = useMemo(
        () => (accountId ? (ownAccount ? [ownAccount] : NO_ACCOUNTS) : (allAccounts ?? NO_ACCOUNTS)),
        [accountId, ownAccount, allAccounts]
    )
    const deletedEventKeys = useWatchEventStore(state => enabled ? state.deletedEventKeys : NO_DELETED_EVENT_KEYS)
    const scopes = useMemo(() => accounts.filter(account => !accountId || account.id === accountId)
        .flatMap(account => (account.connections || []).filter(connection => connection.platform === 'jellyfin').map(connection => ({ accountId: account.id, connection }))), [accounts, accountId])
    // Cards may idle back their /Sessions cadence; page-scope consumers
    // (accountId undefined: Activity and the other full pages) always keep 15s.
    const { results, refresh, busy, initialLoading, mediaSettling } = useJellyfinMediaConnections(
        scopes,
        accountId ? { ...options, sessionsBackoff: true } : options,
    )
    const [playbackExpiry, setPlaybackExpiry] = useState(0)
    const previousHistory = useRef<ActivityItem[]>([])
    const projectors = useRef(new Map<string, ReturnType<typeof createJellyfinActivityProjector>>())
    const historyInputs = useRef<{ sources: ActivityItem[][]; deleted: typeof deletedEventKeys } | null>(null)
    const activity = useMemo(() => {
    const sources: ActivityItem[][] = []
    const activeProjectors = new Map<string, ReturnType<typeof createJellyfinActivityProjector>>()
    let inProgress: ActivityItem[] = []
    const playback: MediaPlayback[] = []
    for (const result of results) {
        const played = result.historyPlayed
        if (result.error && played.status !== 'success') continue
        const colorIndex = accountId
            ? (ownColorIndex >= 0 ? ownColorIndex : 0)
            : accounts.findIndex(account => account.id === result.accountId)
        const account = accountId ? ownAccount : accounts[colorIndex]
        if (!account) continue
        const key = JSON.stringify([result.accountId, result.connection.id])
        const project = projectors.current.get(key) ?? createJellyfinActivityProjector()
        activeProjectors.set(key, project)
        const media = project(account, colorIndex, result.connection, played === result.reads.played ? result.reads : { ...result.reads, played })
        sources.push(media.history)
        inProgress = mergeMediaItems(inProgress, media.inProgress)
        playback.push(...media.playback)
    }
    projectors.current = activeProjectors
    playback.sort(compareMediaPlayback)
    const notDeleted = (item: ActivityItem) => {
        const deletedAt = mediaDeletedAt(deletedEventKeys, item.accountId, getEpisodeIdentity(item.itemId, item.uniqueItemId, item.season, item.episode, item.type), item as JellyfinActivityItem)
        return deletedAt === undefined || item.timestamp.getTime() > deletedAt
    }
    // Projectors check date eligibility before reusing a source. Session-only
    // changes can then skip both the historical merge and deep comparison.
    const previous = historyInputs.current
    const unchanged = previous?.deleted === deletedEventKeys && previous.sources.length === sources.length
        && sources.every((source, index) => source === previous.sources[index])
    let sharedHistory = previousHistory.current
    if (!unchanged) {
        let history: ActivityItem[] = []
        for (const source of sources) history = mergeMediaHistory(history, source)
        sharedHistory = reuseActivityItems(previousHistory.current, history.filter(notDeleted))
    }
    historyInputs.current = { sources, deleted: deletedEventKeys }
    previousHistory.current = sharedHistory
    return { history: sharedHistory, inProgress: inProgress.filter(notDeleted), playback: playback.filter(entry => notDeleted(entry.item)) }
    // The expiry tick intentionally reruns the time-sensitive live-session gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [results, accounts, accountId, ownAccount, ownColorIndex, deletedEventKeys, playbackExpiry])
    useEffect(() => {
        let deadline = Infinity
        // Schedule from the live entries this render accepted. If a deadline
        // passed before effects ran, one immediate tick removes that entry.
        for (const entry of activity.playback) {
            const reportedAt = entry.item.mediaObservation?.reportedAt
            if (entry.state !== 'resume' && reportedAt !== undefined && Number.isFinite(reportedAt)) deadline = Math.min(deadline, reportedAt + 120_001)
        }
        if (!Number.isFinite(deadline)) return
        const timer = setTimeout(() => setPlaybackExpiry(value => value + 1), Math.max(1, deadline - Date.now()))
        return () => clearTimeout(timer)
    }, [activity.playback])
    const readIssues = useMemo(() => results.flatMap(result => {
        const source = { accountId: result.accountId, connectionId: result.connection.id, productName: result.connection.mediaServer?.productName || 'Jellyfin', serverKey: mediaServerKey(result.connection.mediaServer, result.connection.id) }
        if (result.error) return [{ ...source, label: 'Connection', message: result.error, cause: { code: 'unlock' as const } }]
        const issues: MediaReadIssue[] = []
        for (const key of ['resume', 'played', 'sessions'] as const) {
            const read = result.reads[key]
            const label = key === 'resume' ? 'Continue watching' : key === 'played' ? 'Played titles' : 'Live playback'
            if (read.status !== 'waiting' && read.status !== 'success') issues.push({ ...source, label, message: read.message, ...('cause' in read && read.cause ? { cause: read.cause } : {}) })
            else if (key !== 'sessions' && read.status === 'success' && 'complete' in read.data && !read.data.complete) {
                const data = read.data
                if (data.inProgress === true) continue
                if (data.limited) {
                    const count = data.items.length.toLocaleString()
                    const total = data.total === null ? '' : ` of ${data.total.toLocaleString()}`
                    issues.push({ ...source, label, kind: 'limit', message: `Showing ${count}${total} titles. Activity loads up to ${data.limit.toLocaleString()} per connection.` })
                } else {
                    const count = data.items.length.toLocaleString()
                    const returned = data.total === null ? `${count} titles were returned` : `${count} of ${data.total.toLocaleString()} titles were returned`
                    const aiom = result.connection.mediaServer?.product === 'aiometadata' || source.productName.toLowerCase() === 'aiometadata'
                    const sourceCountOnly = key === 'played' && aiom && data.paginationComplete === true
                        && data.total !== null && data.total > data.items.length
                    const explanation = sourceCountOnly && data.total !== null
                        ? `All ${count} returned titles are loaded. AIOMetadata reports ${data.total.toLocaleString()} history entries; that total may include filtered, duplicate or unavailable entries.`
                        : `${returned}. The server listing could not be verified as complete; all returned titles are loaded.`
                    issues.push({ ...source, label, message: explanation, ...(sourceCountOnly ? { kind: 'source-count' as const } : {}) })
                }
            }
        }
        return issues
    }), [results])
    return { ...activity, readIssues, refresh, busy, initialLoading, mediaSettling }
}
