import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image as ImageIcon, Loader2, RefreshCw } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsGroup, SettingsGroupFooter, SettingsGroupLabel, SettingsRowSeparator } from '@/components/settings/SettingsRows'
import { useAccountStore } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import { useUIStore } from '@/store/uiStore'
import { useConnectionStore } from '@/store/connectionStore'
import { useVaultStore } from '@/store/vaultStore'
import { useSyncStore } from '@/store/syncStore'
import { getSyncPasswordHeader } from '@/lib/sync-auth'
import { decrypt } from '@/lib/crypto'
import { openJellyfinSecret } from '@/lib/jellyfin/connection-data'
import { maskProfileLevel, maskEmailLevel, cn } from '@/lib/utils'
import { toast } from '@/hooks/use-toast'
import { isAIOStreamsAddon, parseAIOStreamsUrl, fetchAIOStreamsUser, updateAIOStreamsUser, sanitizeAIOStreamsConfigForUpdate, getStoredAIOStreamsPassword, getStoredAIOStreamsAccessKey, saveAIOStreamsAccessKey, removeAIOStreamsAccessKey } from '@/lib/aiostreams-utils'
import { isAIOMetadataAddon, parseAIOMetadataUrl, fetchAIOMetadataConfig, updateAIOMetadataConfig, getStoredAIOMetadataPassword, getStoredAIOMetadataAddonPassword, saveAIOMetadataAddonPassword, removeAIOMetadataAddonPassword, getAIOMetadataConfigVersion } from '@/lib/aiometadata-utils'
import { readJellyfinAvatar, writeJellyfinAvatar, removeJellyfinAvatar, fetchJellyfinAvatarBytes, dataUrlToJellyfinImage } from '@/lib/connection-pictures/jellyfin-avatar'
import { CANT_CHANGE_COPY } from '@/lib/connection-pictures/types'
import { writeAIOStreamsAvatar, writeAIOMetadataAvatar, readAIOStreamsAvatar, readAIOMetadataAvatar, FACADE_AVATAR_WRITE_ENABLED, probeAIOMetadataAddonPassword, facadeAuthRejectionMessage, isAIOStreamsAccessKeyRejection } from '@/lib/connection-pictures/facade-avatar'
import { buildPictureTargets, facadeInstanceHasLogin, facadeOrigin, type FacadeLoginHint } from '@/lib/connection-pictures/targets'
import { deriveRowStatus, planSync, skipLabel, followsDefaultAfterWrite, staleConfirmRowIds, accountMarkerFor, classifyWriteReadback, restoreReadbackMatches, accountDefaultPlan, accountDefaultBlocked } from '@/lib/connection-pictures/row-state'
import { staleConnectionPictureRowIds } from '@/lib/connection-pictures/sync-merge'
import { sanitizePlatformAvatarSrc, sanitizeServerImageSrc, sanitizeAvatarDataUri, AVATAR_UPLOAD_MAX_BYTES } from '@/lib/connection-pictures/avatar-value'
import { AIOStreamsAuthError } from '@/lib/aiostreams-config-safety'
import type { PictureRow, PictureRowCurrent, PictureRowStatus, PictureSpec, PlannedUndo, UndoRestore } from '@/lib/connection-pictures/types'
import { PicturePickerSheet } from './PicturePickerSheet'
import { PlatformLogo } from '@/components/providers/ConnectionPrimitives'
import type { AddonDescriptor } from '@/types/addon'

interface ConnectionPicturesSectionProps {
    accountId: string
}

interface FacadeHint {
    baseUrl: string
    uuid: string
    passwordResolved: boolean
    password: string
    accessKey?: string
    addonPassword?: string
}

interface FacadeAccessState {
    secret: string
    none: boolean
    /**
     * AIOMetadata only: verified against the instance with a read-only
     * authenticated load (CP-R3-001). AIOStreams has no read-only key check,
     * so its entered key stays unverified here and the confirmed write checks it.
     */
    verified: boolean
    /** The secret is backed by a vault entry: the row offers Change key and Forget key. */
    saved: boolean
}

interface ResolvedHints {
    aiostreams: FacadeHint[]
    aiometadata: FacadeHint[]
}

interface RowRead {
    row: PictureRow
    status: PictureRowStatus
    error?: string
}

interface ConfirmWrite {
    row: PictureRow
    spec: PictureSpec
    previous: PictureRowCurrent
    wasOverride: boolean
    /** Explicit "Use account picture" opt back in: the row follows the default after the write. */
    refollowsDefault: boolean
    /** The marker shown in the confirm sheet; re-read before writing must still match. */
    confirmedMarker: string | null
    /** The persisted row revision at confirm time; any bump invalidates the confirm. */
    confirmedRevision: number
    /** Replays of the same write reuse this token so a double click cannot double write. */
    idempotencyKey: string
}

async function proxyAuthHeaders(): Promise<Record<string, string>> {
    const auth = useSyncStore.getState().auth
    if (!auth.isAuthenticated) return {}
    return { 'x-sync-user': auth.id, 'x-sync-password': await getSyncPasswordHeader(auth) }
}

/**
 * Per-platform img src allowlist: platform-stored avatar strings are strict,
 * configured server URLs may be http. A locally chosen Jellyfin upload preview
 * is a bounded raster data URI, so it passes sanitizeAvatarDataUri before the
 * server-URL allowlist (SOL 4); SVG, other schemes and oversized payloads stay
 * rejected because neither allowlist accepts them.
 */
function safeImgSrc(platform: PictureRow['platform'], value: string | null | undefined): string | null {
    if (platform === 'jellyfin') return sanitizeAvatarDataUri(value) ?? sanitizeServerImageSrc(value)
    return sanitizePlatformAvatarSrc(value)
}

/** Fetches an https avatar link's bytes through the SSRF-guarded server proxy. */
async function fetchImageBytesViaProxy(url: string): Promise<{ base64: string; mime: string; bytes: Uint8Array } | null> {
    const res = await fetch(`/api/meta-proxy?url=${encodeURIComponent(url)}&nocache=1`, { headers: await proxyAuthHeaders() })
    if (!res.ok) return null
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
    const buf = new Uint8Array(await res.arrayBuffer())
    // CP-R2-005: downloads are capped at the transport budget so an oversized
    // remote image never reaches a byte platform (or memory) unbounded.
    if (buf.byteLength === 0 || buf.byteLength > AVATAR_UPLOAD_MAX_BYTES) return null
    return { bytes: buf, mime, base64: '' }
}

/** Splits a facade row id back into baseUrl and uuid. */
function facadeRowTarget(row: PictureRow): { baseUrl: string; uuid: string } | null {
    const rest = row.id.slice(row.platform === 'aiostreams' ? 'aiostreams:'.length : 'aiometadata:'.length)
    const sep = rest.lastIndexOf('|')
    if (sep <= 0) return null
    return { baseUrl: rest.slice(0, sep), uuid: rest.slice(sep + 1) }
}

/**
 * Connection pictures group (owner pick 2026-11-05 option C + amendment, scope
 * change 2026-11-05: Jellyfin family only): the account picture is the default
 * for every picture-capable connection; each row shows the platform's current
 * picture and sync status, keeps pictures set elsewhere, and only the user's
 * Sync action writes anything.
 */
export function ConnectionPicturesSection({ accountId }: ConnectionPicturesSectionProps) {
    const encryptionKey = useAuthStore(s => s.encryptionKey)
    const vaultLocked = useVaultStore(s => s.isLocked)
    const namePrivacyLevel = useUIStore(s => s.privacyLevelNames)
    const emailPrivacyLevel = useUIStore(s => s.privacyLevelEmail)
    const liveAccount = useAccountStore(useCallback(s => s.accounts.find(a => a.id === accountId) ?? null, [accountId]))
    const setRowState = useConnectionStore(s => s.setConnectionPictureState)
    const account = liveAccount

    const [hints, setHints] = useState<ResolvedHints | null>(null)
    const [reads, setReads] = useState<RowRead[]>([])
    const [readPhase, setReadPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
    const [overrides, setOverrides] = useState<Record<string, PictureSpec>>({})
    const [refollows, setRefollows] = useState<Record<string, boolean>>({})
    const [facadeAccess, setFacadeAccess] = useState<Record<string, FacadeAccessState>>({})
    const [keyDialogFor, setKeyDialogFor] = useState<string | null>(null)
    const [keyDialogValue, setKeyDialogValue] = useState('')
    const [keyDialogVerifying, setKeyDialogVerifying] = useState(false)
    const [keyDialogError, setKeyDialogError] = useState<string | null>(null)
    const [pickerFor, setPickerFor] = useState<string | null>(null)
    const [previewFor, setPreviewFor] = useState<string | null>(null)
    const [confirmWrites, setConfirmWrites] = useState<ConfirmWrite[] | null>(null)
    const [confirmSkips, setConfirmSkips] = useState<Array<{ row: PictureRow; reason: string }> | null>(null)
    const [syncing, setSyncing] = useState(false)
    const undoRef = useRef<PlannedUndo[]>([])
    const loadSeq = useRef(0)
    const probedAddonPasswords = useRef(new Set<string>())

    const storedByRow = useMemo(() => account?.connectionPictures ?? {}, [account?.connectionPictures])

    const accountSpec: PictureSpec = useMemo(() => {
        const avatar = account?.avatar
        if (!avatar) return { kind: 'none' }
        return avatar.startsWith('data:') ? { kind: 'dataUrl', dataUrl: avatar } : { kind: 'url', url: avatar }
    }, [account?.avatar])

    const facadeAccessRef = useRef(facadeAccess)
    facadeAccessRef.current = facadeAccess
    const encryptionKeyRef = useRef(encryptionKey)
    encryptionKeyRef.current = encryptionKey

    const facadeInputs = useCallback((list: FacadeHint[], prefix: 'aiostreams' | 'aiometadata', accessMap: Record<string, FacadeAccessState>) => list.map(i => ({
        baseUrl: i.baseUrl,
        uuid: i.uuid,
        passwordResolved: i.passwordResolved,
        accessConfirmed: (() => {
            const access = accessMap[`${prefix}:${i.baseUrl}|${i.uuid}`]
            if (!access) return false
            // CP-R3-001: AIOStreams has no read-only key check (reads are
            // ungated upstream), so an entered key (or a keyless declaration)
            // unlocks the row and the user-confirmed write checks it. AIOMetadata
            // still requires the read-only verified probe.
            if (prefix === 'aiostreams') return access.none || access.secret !== ''
            return access.verified === true
        })(),
        writeEnabled: FACADE_AVATAR_WRITE_ENABLED,
    })), [])

    const rows = useMemo(() => buildPictureTargets({
        account: {
            connections: account?.connections,
            addons: (account?.addons ?? []) as AddonDescriptor[],
        },
        // Read from state, not the ref: a key check can finish after a newer refresh set
        // the hints, and the rows must still unlock without another refresh.
        aiostreamsInstances: hints ? facadeInputs(hints.aiostreams, 'aiostreams', facadeAccess) : [],
        aiometadataInstances: hints ? facadeInputs(hints.aiometadata, 'aiometadata', facadeAccess) : [],
    }), [account?.connections, account?.addons, hints, facadeInputs, facadeAccess])

    const enabledConnections = useMemo(() => (account?.connections ?? []).filter(c => c.enabled !== false && c.status !== 'expired'), [account?.connections])

    /**
     * CP-R2-001 + scope change + SOL 10: an auth-style failure relocks the row
     * for this session. The saved AIOStreams key leaves the vault only for a
     * proven instance access-key rejection (ADDON_PASSWORD_INVALID mapped to
     * AIOStreamsAccessKeyError, carried as the facade outcome's rejection
     * code). A local proxy 401, a config-password error or a text match keeps
     * the stored key.
     */
    const clearFacadeAccessOnAuthError = useCallback((row: PictureRow, err: unknown) => {
        if (row.platform !== 'aiostreams' && row.platform !== 'aiometadata') return
        const message = err instanceof Error ? err.message
            : typeof err === 'string' ? err
            : err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message
            : ''
        const accessKeyRejected = isAIOStreamsAccessKeyRejection(err)
        const authish = accessKeyRejected
            || err instanceof AIOStreamsAuthError
            || /access key|addon password|invalid password|unauthorized|\b401\b|\b403\b|decrypt/i.test(message)
        if (!authish) return
        setFacadeAccess(prev => (prev[row.id] ? { ...prev, [row.id]: { secret: '', none: false, verified: false, saved: false } } : prev))
        if (row.platform === 'aiostreams' && accessKeyRejected) {
            const target = facadeRowTarget(row)
            if (target) void removeAIOStreamsAccessKey(target.baseUrl, target.uuid)
        }
    }, [])

    const readRowCurrent = useCallback(async (row: PictureRow, resolved: ResolvedHints, preloaded?: Map<string, Record<string, unknown>>): Promise<PictureRowCurrent> => {
        if (row.platform === 'jellyfin') {
            const conn = enabledConnections.find(c => c.id === row.id.slice('jellyfin:'.length))
            if (!conn || !encryptionKeyRef.current) return { marker: null, thumbUrl: null }
            const secret = await openJellyfinSecret(conn, value => decrypt(value, encryptionKeyRef.current!))
            const read = await readJellyfinAvatar({
                baseUrl: secret.baseUrl,
                accessToken: secret.accessToken,
                deviceId: secret.deviceId,
                userId: secret.userId,
                serverVersion: conn.mediaServer?.version,
            })
            return { marker: read.tag ?? '', thumbUrl: sanitizeServerImageSrc(read.thumbUrl) }
        }
        if (row.platform === 'aiostreams') {
            const inst = resolved.aiostreams.find(i => row.id === `aiostreams:${i.baseUrl}|${i.uuid}`)
            if (!inst || !inst.passwordResolved) return { marker: null, thumbUrl: null }
            try {
                const { userData } = await fetchAIOStreamsUser(inst.baseUrl, inst.uuid, inst.password, { raw: true })
                const read = readAIOStreamsAvatar(userData)
                return { marker: read.marker, thumbUrl: sanitizePlatformAvatarSrc(read.marker) }
            } catch (err) {
                clearFacadeAccessOnAuthError(row, err)
                throw err
            }
        }
        const inst = resolved.aiometadata.find(i => row.id === `aiometadata:${i.baseUrl}|${i.uuid}`)
        if (!inst || !inst.passwordResolved) return { marker: null, thumbUrl: null }
        try {
            const config = preloaded?.get(row.id) ?? await fetchAIOMetadataConfig(inst.baseUrl, inst.uuid, inst.password, inst.addonPassword)
            const read = readAIOMetadataAvatar(config)
            return { marker: read.marker, thumbUrl: sanitizePlatformAvatarSrc(read.marker) }
        } catch (err) {
            clearFacadeAccessOnAuthError(row, err)
            throw err
        }
    }, [enabledConnections, clearFacadeAccessOnAuthError])

    /** probeConfigs (refresh only) receives each AIOMetadata config the saved-key check loaded, so the row read reuses it. */
    const resolveHints = useCallback(async (probeConfigs?: Map<string, Record<string, unknown>>): Promise<ResolvedHints> => {
        const resolved: ResolvedHints = { aiostreams: [], aiometadata: [] }
        if (!account) return resolved
        if (!vaultLocked) {
            // Facade rows need a Jellyfin login on that instance; the plain addon alone has no login picture.
            const logins: FacadeLoginHint[] = []
            const cipherKey = encryptionKeyRef.current
            for (const c of account.connections ?? []) {
                const product = c.mediaServer?.product
                if (c.platform !== 'jellyfin' || (product !== 'aiostreams' && product !== 'aiometadata')) continue
                if (c.enabled === false || c.status === 'expired' || c.status === 'pending' || !cipherKey) continue
                try {
                    const secret = await openJellyfinSecret(c, value => decrypt(value, cipherKey))
                    const origin = facadeOrigin(secret.baseUrl)
                    if (origin) logins.push({ product, origin, userKeys: [secret.userId, c.mediaServer?.userName ?? ''].filter(Boolean) })
                } catch { /* unreadable login: no row for it */ }
            }
            if (logins.length === 0) return resolved
            const addonList = (account.addons ?? []) as AddonDescriptor[]
            const aiosCandidates = addonList.flatMap(a => isAIOStreamsAddon(a) && a.transportUrl ? [parseAIOStreamsUrl(a.transportUrl)].filter((x): x is NonNullable<typeof x> => !!x) : [])
            const aiomCandidates = addonList.flatMap(a => isAIOMetadataAddon(a) && a.transportUrl ? [parseAIOMetadataUrl(a.transportUrl)].filter((x): x is NonNullable<typeof x> => !!x) : [])
            const seen = new Set<string>()
            for (const addon of addonList) {
                const transportUrl = addon.transportUrl
                if (!transportUrl) continue
                if (isAIOStreamsAddon(addon)) {
                    const parsed = parseAIOStreamsUrl(transportUrl)
                    if (!parsed) continue
                    if (!facadeInstanceHasLogin('aiostreams', parsed, logins, aiosCandidates)) continue
                    const key = `aios:${parsed.baseUrl}|${parsed.uuid}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    const password = getStoredAIOStreamsPassword(parsed.baseUrl, parsed.uuid) || ''
                    const rowId = `aiostreams:${parsed.baseUrl}|${parsed.uuid}`
                    const access = facadeAccessRef.current[rowId]
                    // Scope change: a saved access key seeds the row (and every
                    // write) without re-entry; the confirmed write checks it.
                    const storedKey = getStoredAIOStreamsAccessKey(parsed.baseUrl, parsed.uuid)
                    if (!access && storedKey) {
                        setFacadeAccess(prev => prev[rowId] ? prev : { ...prev, [rowId]: { secret: storedKey, none: false, verified: false, saved: true } })
                    }
                    // A keyless declaration must never fall back to a stale saved key.
                    const effectiveAccessKey = access?.none ? undefined : (access?.secret || storedKey || undefined)
                    resolved.aiostreams.push({
                        baseUrl: parsed.baseUrl, uuid: parsed.uuid, password, passwordResolved: !!password,
                        accessKey: effectiveAccessKey,
                    })
                }
                if (isAIOMetadataAddon(addon)) {
                    const parsed = parseAIOMetadataUrl(transportUrl)
                    if (!parsed) continue
                    if (!facadeInstanceHasLogin('aiometadata', parsed, logins, aiomCandidates)) continue
                    const key = `aiom:${parsed.baseUrl}|${parsed.uuid}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    const password = getStoredAIOMetadataPassword(parsed.baseUrl, parsed.uuid) || ''
                    const rowId = `aiometadata:${parsed.baseUrl}|${parsed.uuid}`
                    const access = facadeAccessRef.current[rowId]
                    const storedAddonPassword = getStoredAIOMetadataAddonPassword(parsed.baseUrl, parsed.uuid)
                    // A keyless declaration must never fall back to a stale saved password.
                    const effectiveAddonPassword = access?.none ? undefined : (access?.secret || storedAddonPassword || undefined)
                    if (storedAddonPassword && !probedAddonPasswords.current.has(rowId) && password) {
                        // Read-only verification once per session so a saved
                        // password unlocks the row only while it still works.
                        probedAddonPasswords.current.add(rowId)
                        const outcome = await probeAIOMetadataAddonPassword(async () => {
                            const config = await fetchAIOMetadataConfig(parsed.baseUrl, parsed.uuid, password, storedAddonPassword)
                            if (probeConfigs && effectiveAddonPassword === storedAddonPassword) probeConfigs.set(rowId, config)
                            return config
                        })
                        if (outcome.ok) {
                            setFacadeAccess(prev => prev[rowId] ? prev : { ...prev, [rowId]: { secret: storedAddonPassword, none: false, verified: true, saved: true } })
                        } else {
                            setFacadeAccess(prev => prev[rowId] ? prev : { ...prev, [rowId]: { secret: storedAddonPassword, none: false, verified: false, saved: true } })
                        }
                    }
                    resolved.aiometadata.push({
                        baseUrl: parsed.baseUrl, uuid: parsed.uuid, password, passwordResolved: !!password,
                        addonPassword: effectiveAddonPassword,
                    })
                }
            }
        }
        return resolved
    }, [account, vaultLocked])

    const refresh = useCallback(async (options?: { suppressOwnFlips?: boolean }): Promise<RowRead[] | undefined> => {
        if (!account || !encryptionKeyRef.current) return undefined
        const seq = ++loadSeq.current
        setReadPhase('loading')
        try {
            const probeConfigs = new Map<string, Record<string, unknown>>()
            const resolved = await resolveHints(probeConfigs)
            if (seq !== loadSeq.current) return undefined
            setHints(resolved)
            const nextRows = buildPictureTargets({
                account: {
                    connections: account.connections,
                    addons: (account.addons ?? []) as AddonDescriptor[],
                },
                aiostreamsInstances: facadeInputs(resolved.aiostreams, 'aiostreams', facadeAccessRef.current),
                aiometadataInstances: facadeInputs(resolved.aiometadata, 'aiometadata', facadeAccessRef.current),
            })
            // Rows read in parallel (each hits a different server or endpoint); order is kept.
            const results: RowRead[] = await Promise.all(nextRows.map(async (row): Promise<RowRead> => {
                try {
                    const current = await readRowCurrent(row, resolved, probeConfigs)
                    const stored = storedByRowRef.current[row.id]
                    const status = deriveRowStatus({ row, stored, current, accountSpec: accountSpecRef.current })
                    // Amendment: a change made elsewhere flips the row to its own picture, persisted.
                    // A caller that persists its own post-write state suppresses this to avoid racing it.
                    if (status.flippedToOwn && !options?.suppressOwnFlips) {
                        void setRowState(accountId, row.id, {
                            followsDefault: false,
                            lastWritten: stored?.lastWritten ?? null,
                            lastWrittenAt: stored?.lastWrittenAt,
                        })
                    }
                    return { row, status }
                } catch (err) {
                    const locked = !!storedByRowRef.current[row.id]?.locked
                    return {
                        row,
                        status: { mode: locked ? 'locked' : 'pending', current: { marker: null, thumbUrl: null }, flippedToOwn: false },
                        error: err instanceof Error ? err.message : 'Read failed',
                    }
                }
            }))
            if (seq !== loadSeq.current) return undefined
            setReads(results)
            setReadPhase(results.some(r => r.error) ? 'error' : 'ready')
            // CP-R2-004: drop synced state for rows whose connection or facade
            // instance no longer exists on the account, so removed targets stop
            // riding every backup and sync blob.
            const staleIds = staleConnectionPictureRowIds(storedByRowRef.current, {
                connectionIds: new Set((account.connections ?? []).map(c => c.id)),
                aiostreamsInstances: new Set(((account.addons ?? []) as AddonDescriptor[]).flatMap(a => {
                    if (!isAIOStreamsAddon(a)) return []
                    const parsed = parseAIOStreamsUrl(a.transportUrl || '')
                    return parsed ? [`${parsed.baseUrl}|${parsed.uuid}`] : []
                })),
                aiometadataInstances: new Set(((account.addons ?? []) as AddonDescriptor[]).flatMap(a => {
                    if (!isAIOMetadataAddon(a)) return []
                    const parsed = parseAIOMetadataUrl(a.transportUrl || '')
                    return parsed ? [`${parsed.baseUrl}|${parsed.uuid}`] : []
                })),
            })
            for (const staleId of staleIds) void setRowState(accountId, staleId, null)
            return results
        } catch {
            if (seq !== loadSeq.current) return undefined
            setReadPhase('error')
            setReads([])
            return undefined
        }
    }, [account, accountId, resolveHints, readRowCurrent, setRowState, facadeInputs])

    // Refs mirror the latest values for the async read loop without re-triggering it.
    const storedByRowRef = useRef(storedByRow)
    storedByRowRef.current = storedByRow
    const accountSpecRef = useRef(accountSpec)
    accountSpecRef.current = accountSpec
    const statusesRef = useRef<Record<string, RowRead>>({})
    const refreshRef = useRef(refresh)
    refreshRef.current = refresh

    /**
     * CP-R3-001: AIOMetadata verifies its addon password with a harmless
     * authenticated config load before the row becomes writable. AIOStreams has
     * NO read-only key check (reads are ungated, writes check config.accessKey),
     * so entering the key only unlocks the row: the user-confirmed avatar write
     * is the check, and a rejected key relocks the row with nothing changed.
     * Scope change: both secrets are persisted to the vault on save, so the
     * user never re-enters them; the row offers Change key and Forget key.
     */
    const verifyFacadeSecret = useCallback(async (row: PictureRow, secret: string, none: boolean) => {
        const target = facadeRowTarget(row)
        if (!target) return
        if (row.platform === 'aiostreams') {
            if (none) await removeAIOStreamsAccessKey(target.baseUrl, target.uuid)
            else await saveAIOStreamsAccessKey(target.baseUrl, target.uuid, secret)
            setFacadeAccess(prev => ({ ...prev, [row.id]: { secret, none, verified: false, saved: !none } }))
            setKeyDialogFor(null)
            setKeyDialogValue('')
            void refreshRef.current()
            return
        }
        if (!hints) return
        const inst = hints.aiometadata.find(i => row.id === `aiometadata:${i.baseUrl}|${i.uuid}`)
        if (!inst) return
        setKeyDialogVerifying(true)
        setKeyDialogError(null)
        try {
            const addonPassword = none ? undefined : secret
            const outcome = await probeAIOMetadataAddonPassword(() => fetchAIOMetadataConfig(inst.baseUrl, inst.uuid, inst.password, addonPassword))
            if (!outcome.ok) {
                setFacadeAccess(prev => ({ ...prev, [row.id]: { secret: '', none: false, verified: false, saved: false } }))
                setKeyDialogError(outcome.message || 'The instance rejected this password.')
                return
            }
            if (none) await removeAIOMetadataAddonPassword(target.baseUrl, target.uuid)
            else await saveAIOMetadataAddonPassword(target.baseUrl, target.uuid, secret)
            setFacadeAccess(prev => ({ ...prev, [row.id]: { secret, none, verified: true, saved: !none } }))
            setKeyDialogFor(null)
            setKeyDialogValue('')
            void refreshRef.current()
        } finally {
            setKeyDialogVerifying(false)
        }
    }, [hints])

    /** Scope change: Forget key withdraws the saved secret; the row returns to read-only. */
    const forgetFacadeKey = useCallback(async (row: PictureRow) => {
        const target = facadeRowTarget(row)
        if (!target) return
        if (row.platform === 'aiostreams') await removeAIOStreamsAccessKey(target.baseUrl, target.uuid)
        else await removeAIOMetadataAddonPassword(target.baseUrl, target.uuid)
        probedAddonPasswords.current.delete(row.id)
        setFacadeAccess(prev => {
            const next = { ...prev }
            delete next[row.id]
            return next
        })
        void refreshRef.current()
    }, [])

    // Reload only when the inputs that shape the rows actually change, not on
    // every store write (our own state persistence recreates the account object).
    const refreshKey = account
        ? `${accountId}|${!!encryptionKeyRef.current}|${vaultLocked}|${account.avatar ?? ''}|${(account.connections ?? []).map(c => `${c.id}:${c.enabled}:${c.status}`).join(',')}|${(account.addons ?? []).length}`
        : ''
    useEffect(() => {
        if (refreshKey) void refreshRef.current()
    }, [refreshKey])

    const statuses = useMemo(() => {
        const map: Record<string, RowRead> = {}
        for (const r of reads) map[r.row.id] = r
        return map
    }, [reads])

    // Reads carry the row as built when the read started; the key state can settle after
    // that (a saved-key check finishing late), so the displayed row comes from live rows.
    const liveReads = useMemo(() => {
        const byId = new Map(rows.map(row => [row.id, row]))
        return reads.map(read => {
            const live = byId.get(read.row.id)
            return live && live !== read.row ? { ...read, row: live } : read
        })
    }, [reads, rows])
    statusesRef.current = statuses

    const plan = useMemo(() => {
        const entries = rows.map(row => ({
            row,
            status: statuses[row.id]?.status ?? { mode: 'pending' as const, current: { marker: null, thumbUrl: null }, flippedToOwn: false },
            stored: storedByRow[row.id],
        }))
        return planSync({ rows: entries, accountSpec, overrides })
    }, [rows, statuses, storedByRow, accountSpec, overrides])

    const writableCount = plan.writes.length

    const openSyncConfirm = () => {
        if (plan.writes.length === 0) return
        setConfirmWrites(plan.writes.map(w => ({
            ...w,
            wasOverride: !!overrides[w.row.id],
            refollowsDefault: !!refollows[w.row.id],
            confirmedMarker: w.previous.marker,
            confirmedRevision: storedByRow[w.row.id]?.revision ?? 0,
            idempotencyKey: crypto.randomUUID(),
        })))
        setConfirmSkips(plan.skips.map(s => ({ row: s.row, reason: s.reason })))
    }

    /** CP-006: "Use account picture" opts the row back into the account default. */
    const applyAccountDefault = useCallback((rowId: string) => {
        const row = rows.find(r => r.id === rowId)
        if (!row) return
        const plan = accountDefaultPlan({
            row,
            accountSpec: accountSpecRef.current,
            currentMarker: statusesRef.current[rowId]?.status.current.marker,
        })
        setRefollows(prev => ({ ...prev, [rowId]: true }))
        setOverrides(prev => { const next = { ...prev }; delete next[rowId]; return next })
        if (plan.action === 'persist-refollow') {
            // The platform already shows the account picture: nothing to write,
            // persist the re-follow immediately.
            void setRowState(accountId, rowId, {
                followsDefault: true,
                lastWritten: plan.marker,
                lastWrittenAt: Date.now(),
            })
        } else if (plan.action === 'queue-write') {
            // Queue the account picture as this row's next write; the re-follow
            // lands when that write succeeds.
            setOverrides(prev => ({ ...prev, [rowId]: plan.spec }))
        }
    }, [rows, accountId, setRowState])

    const pickerRow = rows.find(r => r.id === pickerFor) ?? null
    const previewRow = rows.find(r => r.id === previewFor) ?? null
    const keyDialogRow = rows.find(r => r.id === keyDialogFor) ?? null

    /** https link avatars travel through the SSRF-guarded meta proxy to get bytes for byte platforms. */
    const uploadBytesFor = useCallback(async (spec: PictureSpec): Promise<{ base64: string; mime: string; bytes: Uint8Array } | null> => {
        if (spec.kind !== 'url') return null
        const res = await fetchImageBytesViaProxy(spec.url)
        return res
    }, [])

    const writeRow = useCallback(async (row: PictureRow, spec: PictureSpec, resolved: ResolvedHints): Promise<UndoRestore> => {
        if (row.platform === 'jellyfin') {
            const conn = enabledConnections.find(c => c.id === row.id.slice('jellyfin:'.length))
            if (!conn || !encryptionKeyRef.current) throw new Error('Sign in to this Jellyfin connection first')
            const secret = await openJellyfinSecret(conn, value => decrypt(value, encryptionKeyRef.current!))
            const ctx = {
                baseUrl: secret.baseUrl,
                accessToken: secret.accessToken,
                deviceId: secret.deviceId,
                userId: secret.userId,
                serverVersion: conn.mediaServer?.version,
            }
            const previous = await fetchJellyfinAvatarBytes(ctx)
            const restore: UndoRestore = { platform: 'jellyfin', previousBase64: previous?.base64 ?? null, previousMime: previous?.mime ?? null }
            if (spec.kind === 'none') {
                const outcome = await removeJellyfinAvatar(ctx)
                if (!outcome.ok) throw new Error(outcome.reason === 'forbidden' ? CANT_CHANGE_COPY : outcome.message)
                return restore
            }
            const fromData = spec.kind === 'dataUrl' ? dataUrlToJellyfinImage(spec.dataUrl) : null
            const bytes = fromData ?? await uploadBytesFor(spec)
            if (!bytes) throw new Error('Could not read the picture bytes')
            const outcome = await writeJellyfinAvatar(ctx, { base64: bytes.base64, mime: bytes.mime })
            if (!outcome.ok) throw new Error(outcome.reason === 'forbidden' ? CANT_CHANGE_COPY : outcome.message)
            return restore
        }
        if (row.platform === 'aiostreams') {
            const inst = resolved.aiostreams.find(i => row.id === `aiostreams:${i.baseUrl}|${i.uuid}`)
            if (!inst || !inst.passwordResolved) throw new Error('Unlock the vault to change this AIOStreams picture')
            const url = spec.kind === 'url' ? spec.url : null
            if (!url) throw new Error('AIOStreams needs a public image link')
            const previous = statusesRef.current[row.id]?.status.current.marker ?? ''
            const outcome = await writeAIOStreamsAvatar({
                fetch: async () => (await fetchAIOStreamsUser(inst.baseUrl, inst.uuid, inst.password, { raw: true })).userData,
                write: async (next) => {
                    await updateAIOStreamsUser(inst.baseUrl, inst.uuid, inst.password, sanitizeAIOStreamsConfigForUpdate(next), { instanceAccessKey: inst.accessKey })
                },
                readback: async () => (await fetchAIOStreamsUser(inst.baseUrl, inst.uuid, inst.password, { raw: true })).userData,
            }, url, { instanceKey: row.id })
            if (!outcome.ok) {
                // CP-R3-001 + SOL 10: the confirmed write IS the key check; an
                // auth-style rejection relocks the row, and only a proven
                // access-key rejection clears the stored key.
                clearFacadeAccessOnAuthError(row, outcome)
                const rejected = facadeAuthRejectionMessage(outcome.message)
                throw new Error(rejected ?? outcome.message)
            }
            return { platform: 'aiostreams', previousUrl: previous || null }
        }
        const inst = resolved.aiometadata.find(i => row.id === `aiometadata:${i.baseUrl}|${i.uuid}`)
        if (!inst || !inst.passwordResolved) throw new Error('Unlock the vault to change this AIOMetadata picture')
        const url = spec.kind === 'url' ? spec.url : null
        if (!url) throw new Error('AIOMetadata needs a public image link')
        const previous = statusesRef.current[row.id]?.status.current.marker ?? ''
        let baseVersion: number | undefined
        const outcome = await writeAIOMetadataAvatar({
            fetch: async () => {
                const config = await fetchAIOMetadataConfig(inst.baseUrl, inst.uuid, inst.password, inst.addonPassword)
                baseVersion = getAIOMetadataConfigVersion(config) ?? undefined
                return config
            },
            write: async (next) => {
                await updateAIOMetadataConfig(inst.baseUrl, inst.uuid, inst.password, next, inst.addonPassword, { baseVersion })
            },
            readback: async () => fetchAIOMetadataConfig(inst.baseUrl, inst.uuid, inst.password, inst.addonPassword),
        }, url, { instanceKey: row.id })
        if (!outcome.ok) {
            clearFacadeAccessOnAuthError(row, outcome)
            const rejected = facadeAuthRejectionMessage(outcome.message)
            throw new Error(rejected ?? outcome.message)
        }
        return { platform: 'aiometadata', previousUrl: previous || null }
    }, [enabledConnections, uploadBytesFor, clearFacadeAccessOnAuthError])

    /**
     * Fresh platform marker for the pre-write compare-and-set (CP-004): a
     * direct read of the platform with nothing cached in between, so a change
     * made elsewhere between the confirm and the run is actually observed. A
     * failed read returns undefined so the confirm fails closed.
     */
    const freshMarkerFor = useCallback(async (row: PictureRow, resolved: ResolvedHints): Promise<string | null | undefined> => {
        try {
            return (await readRowCurrent(row, resolved)).marker ?? null
        } catch {
            return undefined
        }
    }, [readRowCurrent])

    const runSync = useCallback(async () => {
        const writes = confirmWrites
        if (!writes || !account || !hints) return
        setSyncing(true)
        const undo: PlannedUndo[] = []
        const failures: string[] = []
        const results: Array<{ write: ConfirmWrite; ok: boolean }> = []
        const norm = (v: string | null | undefined) => (v == null || v === '' ? '' : v)
        /** CP-R2-003: flip a raced row to its own picture; sync never retries over it. */
        const markChangedElsewhere = (write: ConfirmWrite) => {
            const stored = storedByRowRef.current[write.row.id]
            void setRowState(accountId, write.row.id, {
                followsDefault: false,
                lastWritten: stored?.lastWritten ?? null,
                lastWrittenAt: stored?.lastWrittenAt,
            })
        }
        try {
            for (const write of writes) {
                // Compare-and-set per row (CP-R2-003): the fresh read happens
                // immediately before THIS row's write, so another device never
                // gets a reread-to-write window across the batch.
                const preWrite = await freshMarkerFor(write.row, hints)
                const revisionNow = storedByRowRef.current[write.row.id]?.revision ?? 0
                const staleRow = staleConfirmRowIds(
                    [{ rowId: write.row.id, marker: write.confirmedMarker, revision: write.confirmedRevision }],
                    { [write.row.id]: preWrite },
                    { [write.row.id]: revisionNow },
                )
                if (staleRow.length > 0) {
                    const changedElsewhere = preWrite !== undefined && norm(preWrite) !== norm(write.confirmedMarker)
                    failures.push(`${write.row.label}: ${changedElsewhere ? 'changed elsewhere, row skipped' : 'current picture could not be confirmed, row skipped'}`)
                    results.push({ write, ok: false })
                    if (changedElsewhere) markChangedElsewhere(write)
                    continue
                }
                try {
                    const restore = await writeRow(write.row, write.spec, hints)
                    // Post-write readback: the marker must now be ours; a value
                    // that is neither ours nor the pre-write one was changed
                    // elsewhere and the row flips to its own picture.
                    const after = await freshMarkerFor(write.row, hints)
                    const outcome = classifyWriteReadback({
                        platform: write.row.platform,
                        preWrite: preWrite ?? null,
                        ours: accountMarkerFor(write.row.platform, write.spec),
                        after,
                        removed: write.spec.kind === 'none',
                    })
                    if (outcome === 'changed-elsewhere') {
                        failures.push(`${write.row.label}: changed elsewhere during the write, the row keeps its own picture`)
                        results.push({ write, ok: false })
                        markChangedElsewhere(write)
                        continue
                    }
                    if (outcome !== 'verified') {
                        failures.push(`${write.row.label}: ${outcome === 'unreadable' ? 'the new picture could not be verified, row not counted as synced' : 'the picture did not persist, try again'}`)
                        results.push({ write, ok: false })
                        continue
                    }
                    undo.push({
                        rowId: write.row.id,
                        row: write.row,
                        restore,
                        wasOverride: write.wasOverride,
                        refollowsDefault: write.refollowsDefault,
                        followsDefaultBefore: storedByRowRef.current[write.row.id]?.followsDefault ?? true,
                    })
                    results.push({ write, ok: true })
                } catch (err) {
                    const message = err instanceof Error ? err.message : 'write failed'
                    failures.push(`${write.row.label}: ${message}`)
                    results.push({ write, ok: false })
                    clearFacadeAccessOnAuthError(write.row, err)
                    if (message === CANT_CHANGE_COPY) {
                        const stored = storedByRowRef.current[write.row.id]
                        void setRowState(accountId, write.row.id, {
                            followsDefault: stored?.followsDefault ?? true,
                            lastWritten: stored?.lastWritten ?? null,
                            lastWrittenAt: stored?.lastWrittenAt,
                            locked: true,
                            lockedReason: CANT_CHANGE_COPY,
                        })
                    }
                }
            }
            undoRef.current = undo
            // Re-read everything, then persist row state ONLY for writes that
            // actually succeeded so failed rows are never stamped as written.
            const fresh = await refreshRef.current({ suppressOwnFlips: true })
            for (const result of results) {
                if (!result.ok) continue
                const read = (fresh ?? []).find(r => r.row.id === result.write.row.id) ?? statusesRef.current[result.write.row.id]
                if (!read || read.error) continue
                const stored = storedByRowRef.current[result.write.row.id]
                // URL-value platforms use the exact marker just written (cached row
                // reads can lag the write by up to their TTL); byte platforms keep
                // the freshly read tag.
                const writtenMarker = accountMarkerFor(result.write.row.platform, result.write.spec)
                await setRowState(accountId, result.write.row.id, {
                    followsDefault: followsDefaultAfterWrite({
                        refollowsDefault: result.write.refollowsDefault,
                        wasOverride: result.write.wasOverride,
                        stored,
                    }),
                    lastWritten: writtenMarker !== null ? writtenMarker : (read.status.current.marker ?? null),
                    lastWrittenAt: Date.now(),
                    locked: stored?.locked,
                    lockedReason: stored?.lockedReason,
                })
            }
            setOverrides(prev => {
                const next = { ...prev }
                for (const write of writes) delete next[write.row.id]
                return next
            })
            setRefollows(prev => {
                const next = { ...prev }
                for (const write of writes) delete next[write.row.id]
                return next
            })
            setConfirmWrites(null)
            setConfirmSkips(null)
            if (failures.length > 0) {
                toast({
                    variant: 'destructive',
                    title: 'Some pictures failed',
                    description: `${failures.join('; ')}.${undo.length > 0 ? ' The rows that did change can still be undone.' : ''}`,
                    action: undo.length > 0 ? { label: 'Undo', onClick: () => void runUndoRef.current() } : undefined,
                    duration: 8000,
                })
            } else {
                const count = writes.length
                const canUndo = undo.length > 0
                toast({
                    title: `Synced ${count} ${count === 1 ? 'picture' : 'pictures'}`,
                    description: canUndo ? 'The previous pictures are kept so you can undo.' : undefined,
                    action: canUndo ? { label: 'Undo', onClick: () => void runUndoRef.current() } : undefined,
                    duration: 8000,
                })
            }
        } finally {
            setSyncing(false)
        }
    }, [confirmWrites, account, hints, writeRow, setRowState, accountId, freshMarkerFor, clearFacadeAccessOnAuthError])

    /**
     * CP-R2-002: every restore path THROWS on a missing connection, credential
     * or target (a missing prerequisite can never count as restored), writes
     * the previous value back, and then verifies it by a fresh readback before
     * runUndo counts the row as restored or persists any state.
     */
    const restoreRow = useCallback(async (item: PlannedUndo, resolved: ResolvedHints) => {
        const r = item.restore
        let expected: string | null
        if (r.platform === 'jellyfin') {
            const conn = enabledConnections.find(c => c.id === item.row.id.slice('jellyfin:'.length))
            if (!conn || !encryptionKeyRef.current) throw new Error('Sign in to this Jellyfin connection first, so this row cannot be restored')
            const secret = await openJellyfinSecret(conn, value => decrypt(value, encryptionKeyRef.current!))
            const ctx = { baseUrl: secret.baseUrl, accessToken: secret.accessToken, deviceId: secret.deviceId, userId: secret.userId, serverVersion: conn.mediaServer?.version }
            const image = r.previousBase64 ? { base64: r.previousBase64, mime: r.previousMime || 'image/png' } : null
            const outcome = image ? await writeJellyfinAvatar(ctx, image) : await removeJellyfinAvatar(ctx)
            if (!outcome.ok) throw new Error(outcome.reason === 'forbidden' ? CANT_CHANGE_COPY : outcome.message)
            expected = r.previousBase64 || null
        } else if (r.platform === 'aiostreams') {
            const inst = resolved.aiostreams.find(i => item.row.id === `aiostreams:${i.baseUrl}|${i.uuid}`)
            if (!inst || !inst.passwordResolved) throw new Error('Unlock the vault to restore this AIOStreams picture')
            const outcome = await writeAIOStreamsAvatar({
                fetch: async () => (await fetchAIOStreamsUser(inst.baseUrl, inst.uuid, inst.password, { raw: true })).userData,
                write: async (next) => {
                    await updateAIOStreamsUser(inst.baseUrl, inst.uuid, inst.password, sanitizeAIOStreamsConfigForUpdate(next), { instanceAccessKey: inst.accessKey })
                },
                readback: async () => (await fetchAIOStreamsUser(inst.baseUrl, inst.uuid, inst.password, { raw: true })).userData,
            }, r.previousUrl, { instanceKey: item.row.id })
            if (!outcome.ok) {
                clearFacadeAccessOnAuthError(item.row, outcome)
                throw new Error(outcome.message)
            }
            expected = r.previousUrl ?? ''
        } else {
            const inst = resolved.aiometadata.find(i => item.row.id === `aiometadata:${i.baseUrl}|${i.uuid}`)
            if (!inst || !inst.passwordResolved) throw new Error('Unlock the vault to restore this AIOMetadata picture')
            let undoBaseVersion: number | undefined
            const outcome = await writeAIOMetadataAvatar({
                fetch: async () => {
                    const config = await fetchAIOMetadataConfig(inst.baseUrl, inst.uuid, inst.password, inst.addonPassword)
                    undoBaseVersion = getAIOMetadataConfigVersion(config) ?? undefined
                    return config
                },
                write: async (next) => { await updateAIOMetadataConfig(inst.baseUrl, inst.uuid, inst.password, next, inst.addonPassword, { baseVersion: undoBaseVersion }) },
                readback: async () => fetchAIOMetadataConfig(inst.baseUrl, inst.uuid, inst.password, inst.addonPassword),
            }, r.previousUrl, { instanceKey: item.row.id })
            if (!outcome.ok) {
                clearFacadeAccessOnAuthError(item.row, outcome)
                throw new Error(outcome.message)
            }
            expected = r.previousUrl ?? ''
        }
        const fresh = await freshMarkerFor(item.row, resolved)
        if (fresh === undefined || !restoreReadbackMatches({ platform: r.platform, expected, fresh })) {
            throw new Error('The picture did not restore as expected; it may have changed elsewhere. This row keeps its undo.')
        }
    }, [enabledConnections, freshMarkerFor, clearFacadeAccessOnAuthError])

    const runUndo = useCallback(async () => {
        const planned = undoRef.current
        if (planned.length === 0 || !account || !hints) return
        setSyncing(true)
        const failures: string[] = []
        const restored: PlannedUndo[] = []
        try {
            for (const item of planned) {
                try {
                    await restoreRow(item, hints)
                    restored.push(item)
                } catch (err) {
                    failures.push(`${item.row.label}: ${err instanceof Error ? err.message : 'undo failed'}`)
                }
            }
            // Keep only the entries that did not restore, so a transient failure
            // can be retried and the exact restore set is never lost.
            undoRef.current = planned.filter(item => !restored.includes(item))
            const fresh = await refreshRef.current({ suppressOwnFlips: true })
            for (const item of restored) {
                const read = (fresh ?? []).find(r => r.row.id === item.rowId) ?? statusesRef.current[item.rowId]
                if (!read || read.error) continue
                await setRowState(accountId, item.rowId, {
                    followsDefault: item.followsDefaultBefore ?? true,
                    lastWritten: read.status.current.marker ?? null,
                    lastWrittenAt: Date.now(),
                })
            }
            if (failures.length > 0) {
                toast({
                    variant: 'destructive',
                    title: 'Undo failed for some rows',
                    description: `${failures.join('; ')}. The remaining rows keep their undo.`,
                    action: undoRef.current.length > 0 ? { label: 'Retry', onClick: () => void runUndo() } : undefined,
                    duration: 8000,
                })
            } else {
                toast({ title: 'Reverted to the previous pictures.' })
            }
        } finally {
            setSyncing(false)
        }
    }, [account, hints, restoreRow, setRowState, accountId])

    // Mirror so runSync's toasts can offer Undo without capturing the callback
    // before it exists (runUndo is defined below runSync).
    const runUndoRef = useRef(runUndo)
    runUndoRef.current = runUndo

    if (!account) return null

    // Pictures are Jellyfin login pictures: no Jellyfin-family connection, no section.
    const hasJellyfinLogin = (account.connections ?? []).some(c =>
        c.platform === 'jellyfin' && c.enabled !== false && c.status !== 'expired' && c.status !== 'pending')
    if (!hasJellyfinLogin) return null

    if (rows.length === 0 && readPhase !== 'loading') {
        return (
            <>
                <SettingsGroupLabel>Connection pictures</SettingsGroupLabel>
                <SettingsGroup>
                    <SettingsGroupFooter>
                        No picture-capable connections on this account yet. Connect Jellyfin, AIOStreams or AIOMetadata to sync this picture.
                    </SettingsGroupFooter>
                </SettingsGroup>
            </>
        )
    }

    const lockedRowsHere = rows.filter(r => storedByRow[r.id]?.locked)

    /** CP-003: facade rows blocked on the instance secret stay clickable so the key can be entered and verified. */
    const openRowAction = (row: PictureRow) => {
        if (row.readOnlyReason && (row.platform === 'aiostreams' || row.platform === 'aiometadata')) {
            setKeyDialogError(null)
            setKeyDialogFor(row.id)
        }
        else setPickerFor(row.id)
    }

    return (
        <>
            <SettingsGroupLabel>Connection pictures</SettingsGroupLabel>
            <SettingsGroup>
                {reads.length === 0 && readPhase === 'loading' && (
                    <div className="flex items-center gap-2 px-1.5 py-3 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Reading current pictures...
                    </div>
                )}
                {liveReads.map((read, i) => {
                    const row = read.row
                    const override = overrides[row.id]
                    const status = read.status
                    const capabilityBlocked = !!row.readOnlyReason
                    const needsSecret = capabilityBlocked && (row.platform === 'aiostreams' || row.platform === 'aiometadata')
                    const locked = status.mode === 'locked' || !!storedByRow[row.id]?.locked || (capabilityBlocked && !needsSecret)
                    const rowAccess = facadeAccess[row.id]
                    const savedKey = (row.platform === 'aiostreams' || row.platform === 'aiometadata') && !!rowAccess?.saved
                    const thumb = safeImgSrc(row.platform, override ? specThumb(override) : (status.current.thumbUrl ?? null))
                    return (
                        <div key={row.id}>
                            {i > 0 && <SettingsRowSeparator />}
                            <div className={cn('flex min-h-[56px] w-full items-center gap-3 px-1.5 py-2', locked && 'opacity-80')}>
                                {/* Every row is a Jellyfin login (native, or the AIOStreams/AIOMetadata facade). */}
                                <PlatformLogo platform="jellyfin" product={row.platform === 'jellyfin' ? undefined : row.platform} className="h-7 w-7 shrink-0 rounded-lg" />
                                <button
                                    type="button"
                                    className="min-w-0 flex-1 rounded-xl py-1 text-left transition-colors hover:bg-muted/25"
                                    onClick={() => setPreviewFor(row.id)}
                                    aria-label={`Preview the ${row.label} picture`}
                                >
                                    <span className="block truncate text-sm font-medium">{row.label}</span>
                                    <span className="block truncate text-[11px] text-muted-foreground">{subLabel(row, namePrivacyLevel, emailPrivacyLevel)}</span>
                                    <span className="mt-1 inline-flex flex-wrap items-center gap-2">
                                        {chipFor(status, override, locked, needsSecret)}
                                        {savedKey && (
                                            <>
                                                <button
                                                    type="button"
                                                    className="text-[10px] font-medium text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                                                    onClick={e => { e.stopPropagation(); setKeyDialogError(null); setKeyDialogValue(''); setKeyDialogFor(row.id) }}
                                                >
                                                    Change key
                                                </button>
                                                <button
                                                    type="button"
                                                    className="text-[10px] font-medium text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                                                    onClick={e => { e.stopPropagation(); void forgetFacadeKey(row) }}
                                                >
                                                    Forget key
                                                </button>
                                            </>
                                        )}
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    className="h-7 w-7 shrink-0 overflow-hidden rounded-full border border-border/50 bg-muted/40"
                                    onClick={() => setPreviewFor(row.id)}
                                    aria-label={`Current ${row.label} picture`}
                                >
                                    {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : <span className="text-[9px] font-bold text-muted-foreground">{platformTile(row.platform)}</span>}
                                </button>
                                <button
                                    type="button"
                                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/60 text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                                    onClick={() => openRowAction(row)}
                                    disabled={locked}
                                    aria-label={needsSecret ? `Enter the instance key for ${row.label}` : `Use a different picture for ${row.label}`}
                                >
                                    <ImageIcon className="h-4 w-4" aria-hidden />
                                </button>
                            </div>
                        </div>
                    )
                })}
                <SettingsGroupFooter>
                    {reads.some(r => r.error) && <span className="mt-1 block">Some pictures could not be read; those rows show the last known state.</span>}
                    {lockedRowsHere.length > 0 && <span className="mt-1 block">{lockedRowsHere.map(r => storedByRow[r.id]?.lockedReason || CANT_CHANGE_COPY)[0]}</span>}
                    {liveReads.filter(r => r.row.readOnlyReason).length > 0 && (
                        <span className="mt-1 block">{liveReads.filter(r => r.row.readOnlyReason)[0].row.readOnlyReason}. Open the row's picker button to enter the instance key.</span>
                    )}
                    <span className="mt-1 block">
                        The account picture is the default for every row. Pictures set in a platform's own app are kept; Sync only touches rows listed in the confirm sheet.
                    </span>
                </SettingsGroupFooter>
            </SettingsGroup>

            <div className="flex items-center justify-center gap-2 pt-1">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-full px-3 text-xs"
                    onClick={() => void refresh()}
                    disabled={readPhase === 'loading'}
                >
                    <RefreshCw className={cn('h-3.5 w-3.5', readPhase === 'loading' && 'animate-spin')} aria-hidden />
                    Refresh
                </Button>
                <Button
                    type="button"
                    size="sm"
                    className="h-8 min-w-[180px] rounded-full px-4 text-xs font-semibold"
                    onClick={openSyncConfirm}
                    disabled={writableCount === 0 || syncing || readPhase === 'loading'}
                >
                    {syncing ? 'Syncing...' : writableCount === 0 ? 'Sync pictures' : `Sync ${writableCount} picture${writableCount === 1 ? '' : 's'}`}
                </Button>
            </div>

            {pickerRow && (
                <PicturePickerSheet
                    row={pickerRow}
                    open={pickerFor === pickerRow.id}
                    onOpenChange={(open) => { if (!open) setPickerFor(null) }}
                    accountPicture={account.avatar || ''}
                    accountDefaultDisabled={accountDefaultBlocked(pickerRow, accountSpec)}
                    onPicked={(spec) => {
                        setRefollows(prev => ({ ...prev, [pickerRow.id]: false }))
                        setOverrides(prev => ({ ...prev, [pickerRow.id]: spec }))
                    }}
                    onUseAccountDefault={() => applyAccountDefault(pickerRow.id)}
                />
            )}

            {previewRow && (
                <Dialog open onOpenChange={(open) => { if (!open) setPreviewFor(null) }}>
                    <DialogContent className="sm:max-w-sm">
                        <DialogHeader>
                            <DialogTitle>{previewRow.label} picture</DialogTitle>
                            <DialogDescription>
                                {storedByRow[previewRow.id]?.locked
                                    ? "This row can't change its picture, but this is the picture the platform has."
                                    : 'The picture the platform currently shows.'}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex flex-col items-center gap-3 py-2">
                            <span className="flex h-40 w-40 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-muted/40">
                                {safeImgSrc(previewRow.platform, previewThumbSrc(previewRow, reads, overrides)) ? (
                                    <img src={safeImgSrc(previewRow.platform, previewThumbSrc(previewRow, reads, overrides)) as string} alt="" className="h-full w-full object-cover" />
                                ) : (
                                    <span className="text-3xl font-bold text-muted-foreground">{platformTile(previewRow.platform)}</span>
                                )}
                            </span>
                        </div>
                    </DialogContent>
                </Dialog>
            )}

            {confirmWrites && (
                <Dialog open onOpenChange={(open) => { if (!open && !syncing) { setConfirmWrites(null); setConfirmSkips(null) } }}>
                    <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                            <DialogTitle>Sync picture changes</DialogTitle>
                            <DialogDescription>
                                These connections receive a new picture. The picture currently on each platform is kept so you can undo.
                                {confirmWrites.some(w => w.row.platform === 'jellyfin') && ' Jellyfin is verified best effort: a picture changed at the same time from another device is detected, but only after it lands.'}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="max-h-[40vh] space-y-1 overflow-y-auto">
                            {confirmWrites.map(w => {
                                const oldThumb = safeImgSrc(w.row.platform, w.previous.thumbUrl)
                                const newThumb = safeImgSrc(w.row.platform, specThumb(w.spec))
                                return (
                                    <div key={w.row.id} className="flex items-center gap-3 py-1.5">
                                        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/50 bg-muted/40 text-[9px] font-bold text-muted-foreground">
                                            {oldThumb ? <img src={oldThumb} alt="" className="h-full w-full object-cover" /> : platformTile(w.row.platform)}
                                        </span>
                                        <span aria-hidden className="text-muted-foreground">→</span>
                                        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-primary/50 bg-muted/40 text-[9px] font-bold">
                                            {newThumb ? <img src={newThumb} alt="" className="h-full w-full object-cover" /> : 'New'}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-medium">{w.row.label}</span>
                                            <span className="block truncate text-xs text-muted-foreground">{subLabel(w.row, namePrivacyLevel, emailPrivacyLevel)}</span>
                                        </span>
                                    </div>
                                )
                            })}
                        </div>
                        {confirmSkips && confirmSkips.length > 0 && (
                            <p className="text-xs text-muted-foreground">
                                Skipped: {confirmSkips.map(s => `${s.row.label} (${skipLabel(s.reason as never)})`).join(', ')}.
                            </p>
                        )}
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" className="flex-1" onClick={() => { setConfirmWrites(null); setConfirmSkips(null) }} disabled={syncing}>Cancel</Button>
                            <Button type="button" className="flex-1" onClick={() => void runSync()} disabled={syncing}>
                                {syncing ? 'Syncing...' : `Sync ${confirmWrites.length} picture${confirmWrites.length === 1 ? '' : 's'}`}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            )}
            {keyDialogRow && (
                <Dialog open onOpenChange={(open) => { if (!open) setKeyDialogFor(null) }}>
                    <DialogContent className="sm:max-w-sm">
                        <DialogHeader>
                            <DialogTitle>{keyDialogRow.label} instance key</DialogTitle>
                            <DialogDescription>
                                {keyDialogRow.platform === 'aiostreams'
                                    ? 'Enter this AIOStreams instance access key (set in its dashboard or CONFIG_ACCESS_KEY). AIOStreams offers no read-only key check, so the key is checked when you save a picture: a wrong key is rejected then, nothing is changed, and the row locks again. The key is saved to your vault so you only enter it once.'
                                    : 'Enter this AIOMetadata instance addon password. The password is verified with a harmless config read before the row becomes writable, then saved to your vault so you only enter it once.'}
                            </DialogDescription>
                        </DialogHeader>
                        <Input
                            type="password"
                            value={keyDialogValue}
                            onChange={(e) => setKeyDialogValue(e.target.value)}
                            autoComplete="off"
                            aria-label="Instance key"
                            className="h-11 rounded-xl"
                        />
                        {keyDialogError && (
                            <p className="text-xs text-destructive" role="alert">
                                The instance rejected this key, so the row stays read-only: {keyDialogError}
                            </p>
                        )}
                        <div className="flex flex-col gap-2">
                            <Button
                                type="button"
                                className="w-full"
                                disabled={!keyDialogValue.trim() || keyDialogVerifying}
                                onClick={() => { void verifyFacadeSecret(keyDialogRow, keyDialogValue.trim(), false) }}
                            >
                                {keyDialogVerifying ? 'Verifying key...' : 'Save key'}
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                className="w-full"
                                disabled={keyDialogVerifying}
                                onClick={() => { void verifyFacadeSecret(keyDialogRow, '', true) }}
                            >
                                This instance has no key
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            )}
        </>
    )
}

function platformTile(platform: PictureRow['platform']): string {
    switch (platform) {
        case 'jellyfin': return 'JF'
        case 'aiostreams': return 'AS'
        case 'aiometadata': return 'AM'
    }
}

function subLabel(row: PictureRow, namePrivacyLevel: number, emailPrivacyLevel: number): string {
    if (row.sub.includes('@')) return maskEmailLevel(row.sub, emailPrivacyLevel)
    return maskProfileLevel(row.sub, namePrivacyLevel)
}

function chipFor(status: PictureRowStatus, override: PictureSpec | undefined, locked: boolean, needsSecret = false) {
    const base = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold'
    if (locked) {
        return <span className={cn(base, 'border-destructive/30 bg-destructive/10 text-destructive')}>Can&apos;t change</span>
    }
    if (needsSecret) {
        return <span className={cn(base, 'border-amber-500/30 bg-amber-500/10 text-amber-500')}>Needs instance key</span>
    }
    if (override) {
        return <span className={cn(base, 'border-primary/40 bg-primary/10 text-primary')}>Pending sync</span>
    }
    if (status.mode === 'synced') {
        return <span className={cn(base, 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500')}>Matches account</span>
    }
    if (status.mode === 'own') {
        return <span className={cn(base, 'border-border/60 bg-muted/30 text-foreground')}>Own picture</span>
    }
    return <span className={cn(base, 'border-amber-500/30 bg-amber-500/10 text-amber-500')}>Pending sync</span>
}

function specThumb(spec: PictureSpec): string | null {
    if (spec.kind === 'url') return spec.url
    if (spec.kind === 'dataUrl') return spec.dataUrl
    return null
}

function previewThumbSrc(row: PictureRow, reads: RowRead[], overrides: Record<string, PictureSpec>): string | null {
    const override = overrides[row.id]
    if (override) return specThumb(override)
    return reads.find(r => r.row.id === row.id)?.status.current.thumbUrl ?? null
}
