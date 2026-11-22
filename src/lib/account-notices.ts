import { format, isSameYear } from 'date-fns'
import { sessionKeyCoversUrl } from './session-sync-token.ts'

export interface NoticeAccount {
    id: string
    name?: string | null
    email?: string | null
    emoji?: string | null
    avatar?: string | null
}

export interface AcceptedNotice {
    id: string
    text: string
    createdAt: number
    isNew: boolean
    accountId: string | null
}

export interface NoticeRow<A extends NoticeAccount = NoticeAccount> {
    id: string
    text: string
    dateText: string
    isNew: boolean
    account: A | null
}

export const NOTICE_FALLBACK_TEXT = 'The host made a change to your account.'
export const NOTICE_REVEAL_WINDOW_MS = 1000
const NOTICE_TEXT_MAX = 300
const NOTICE_KEY_RE = /^[a-z]+\.[a-z0-9-]+$/
const REQUEST_TIMEOUT_MS = 10000
const SESSION_KEY_MARGIN_MS = 30_000

export function noticeText(message: unknown, noticeKey: unknown): string {
    const text = typeof message === 'string' ? message.trim() : ''
    if (!text || text === noticeKey || NOTICE_KEY_RE.test(text)) return NOTICE_FALLBACK_TEXT
    return text.length > NOTICE_TEXT_MAX ? `${text.slice(0, NOTICE_TEXT_MAX)}...` : text
}

export function noticeDateText(createdAt: number, now: Date = new Date()): string {
    const date = new Date(createdAt)
    if (Number.isNaN(date.getTime())) return ''
    if (date.toDateString() === now.toDateString()) return `Today, ${format(date, 'HH:mm')}`
    return isSameYear(date, now) ? format(date, 'MMM d') : format(date, 'MMM d, yyyy')
}

function acceptOne(raw: unknown): AcceptedNotice | null {
    if (!raw || typeof raw !== 'object') return null
    const row = raw as Record<string, unknown>
    const id = row.id
    if (typeof id !== 'string' || !id) return null
    const createdAt = typeof row.createdAt === 'number' ? row.createdAt : Number.NaN
    if (!Number.isFinite(createdAt) || createdAt <= 0 || !noticeDateText(createdAt)) return null
    const accountId = row.accountId
    return {
        id,
        text: noticeText(row.message, row.noticeKey),
        createdAt,
        isNew: row.seenAt === null || row.seenAt === undefined,
        accountId: typeof accountId === 'string' ? accountId : null,
    }
}

// Every surface (badge, visibility, list) reads only this validated list.
export function acceptNotices(raw: unknown): AcceptedNotice[] {
    if (!Array.isArray(raw)) return []
    const out: AcceptedNotice[] = []
    const seen = new Set<string>()
    for (const item of raw as unknown[]) {
        try {
            const accepted = acceptOne(item)
            if (accepted && !seen.has(accepted.id)) {
                seen.add(accepted.id)
                out.push(accepted)
            }
        } catch {
            continue
        }
    }
    return out
}

export function toNoticeRows<A extends NoticeAccount>(
    notices: readonly AcceptedNotice[],
    accounts: readonly A[],
    newIds: ReadonlySet<string>,
    now: Date = new Date(),
): NoticeRow<A>[] {
    const byId = new Map(accounts.map(account => [account.id, account]))
    return notices.map(notice => ({
        id: notice.id,
        text: notice.text,
        dateText: noticeDateText(notice.createdAt, now),
        isNew: newIds.has(notice.id),
        account: notice.accountId ? byId.get(notice.accountId) ?? null : null,
    }))
}

export interface NoticesIdentity {
    key: string
    workspaceId: string
    apiBase: string
}

export interface IdentityInputs {
    authId: string
    isAuthenticated: boolean
    isLocked: boolean
    hasVaultKey: boolean
    activeWorkspaceId: string
    apiBase: string
}

// The workspace whose notices may be shown: signed in, vault open, and local storage switched to the same workspace.
export function computeNoticesIdentity(input: IdentityInputs, sanitize: (id: string) => string): NoticesIdentity | null {
    if (!input.isAuthenticated || !input.authId || input.isLocked || !input.hasVaultKey) return null
    if (input.activeWorkspaceId !== sanitize(input.authId)) return null
    return { key: `${input.authId}|${input.apiBase}`, workspaceId: input.authId, apiBase: input.apiBase }
}

export function noticesUrl(identity: NoticesIdentity): string {
    return `${identity.apiBase}/account/notices`
}

export interface NoticesCredentialInputs {
    identity: NoticesIdentity
    device: Record<string, string> | null
    sessionKey: { deviceId: string; token: string; expiresAt: number; base: string } | null
    sessionToken: string | null
    password: string
    now: number
    pageUrl: string
}

export type NoticesCredential = { headers: Record<string, string> } | { password: string } | null

export function chooseNoticesCredential({ identity, device, sessionKey, sessionToken, password, now, pageUrl }: NoticesCredentialInputs): NoticesCredential {
    if (device) return { headers: device }
    const user = identity.workspaceId
    if (sessionKey && sessionKeyCoversUrl(sessionKey.base, noticesUrl(identity), pageUrl) && sessionKey.expiresAt - SESSION_KEY_MARGIN_MS > now) {
        return { headers: { 'x-sync-user': user, 'x-sync-password': sessionKey.token, 'x-sync-device': sessionKey.deviceId } }
    }
    if (sessionToken) return { headers: { 'x-sync-user': user, 'x-sync-password': sessionToken } }
    return password ? { password } : null
}

export type NoticesFetchResult = { ok: true; notices: unknown } | { ok: false }

export async function requestNotices(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<NoticesFetchResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
        const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal, redirect: 'error', cache: 'no-store' })
        if (res.status !== 200) return { ok: false }
        const body = await res.json() as { notices?: unknown } | null
        return Array.isArray(body?.notices) ? { ok: true, notices: body.notices } : { ok: false }
    } catch {
        return { ok: false }
    } finally {
        clearTimeout(timer)
    }
}

export type NoticesStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface NoticesState {
    key: string | null
    status: NoticesStatus
    notices: readonly AcceptedNotice[]
    newIds: ReadonlySet<string>
    newShown: boolean
}

const EMPTY_STATE: NoticesState = { key: null, status: 'idle', notices: [], newIds: new Set(), newShown: false }

export interface NoticesSessionDeps {
    getIdentity: () => NoticesIdentity | null
    fetchNotices: (identity: NoticesIdentity, isCurrent: () => boolean) => Promise<NoticesFetchResult>
    canRequest?: (identity: NoticesIdentity) => boolean
    defer?: (run: () => void) => void
}

export function createNoticesSession({ getIdentity, fetchNotices, canRequest = () => true, defer = run => { setTimeout(run, 0) } }: NoticesSessionDeps) {
    let state: NoticesState = EMPTY_STATE
    let generation = 0
    let mounted = 0
    let scheduled: string | null = null
    const requested = new Set<string>()
    const listeners = new Set<() => void>()
    const set = (next: NoticesState) => {
        state = next
        for (const listener of listeners) listener()
    }
    const currentKey = () => getIdentity()?.key ?? null

    const identityChanged = () => {
        const key = currentKey()
        if (state.key !== null && state.key !== key) {
            generation++
            set(EMPTY_STATE)
        }
        if (mounted > 0) ensureLoaded()
    }

    const ensureLoaded = () => {
        const wanted = getIdentity()
        if (!wanted || requested.has(wanted.key) || scheduled === wanted.key || !canRequest(wanted)) return
        scheduled = wanted.key
        defer(() => {
            scheduled = null
            const identity = getIdentity()
            if (!identity || identity.key !== wanted.key || requested.has(identity.key) || !canRequest(identity)) return
            requested.add(identity.key)
            const run = ++generation
            const isCurrent = () => run === generation && currentKey() === identity.key
            set({ ...EMPTY_STATE, key: identity.key, status: 'loading' })
            void fetchNotices(identity, isCurrent).then(
                result => {
                    if (!isCurrent()) return
                    if (!result.ok) {
                        set({ ...EMPTY_STATE, key: identity.key, status: 'failed' })
                        return
                    }
                    const notices = acceptNotices(result.notices)
                    set({ key: identity.key, status: 'ready', notices, newIds: new Set(notices.filter(n => n.isNew).map(n => n.id)), newShown: false })
                },
                () => { if (isCurrent()) set({ ...EMPTY_STATE, key: identity.key, status: 'failed' }) },
            )
        })
    }

    return {
        getState: () => state,
        subscribe(listener: () => void) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
        identityChanged,
        mount() {
            mounted++
            ensureLoaded()
            return () => { mounted-- }
        },
        visibleNotices(): readonly AcceptedNotice[] {
            const key = currentKey()
            return key !== null && state.key === key && state.status === 'ready' ? state.notices : []
        },
        visibleKey(): string | null {
            const key = currentKey()
            return key !== null && state.key === key && state.status === 'ready' && state.notices.length > 0 ? key : null
        },
        pendingNewCount(): number {
            const key = currentKey()
            if (key === null || state.key !== key || state.status !== 'ready' || state.newShown) return 0
            return state.notices.filter(n => state.newIds.has(n.id)).length
        },
        // The visit that first shows the list keeps its new marks; later visits get none.
        peekNewIds(): ReadonlySet<string> {
            const key = currentKey()
            if (key === null || state.key !== key || state.status !== 'ready' || state.newShown) return new Set()
            return state.newIds
        },
        markNewShown() {
            const key = currentKey()
            if (key === null || state.key !== key || state.status !== 'ready' || state.newShown) return
            set({ ...state, newShown: true })
        },
        requestCount: () => requested.size,
    }
}

export type NoticesSession = ReturnType<typeof createNoticesSession>

export function revealOnThisVisit(visibleCount: number, mountedAt: number, now: number, windowMs = NOTICE_REVEAL_WINDOW_MS): boolean {
    return visibleCount > 0 && now - mountedAt <= windowMs
}
