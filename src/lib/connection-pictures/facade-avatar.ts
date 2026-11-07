// AIOStreams / AIOMetadata facade avatars.
//
// Both facades SERVE profile pictures over the Jellyfin API but accept no
// uploads through it (upstream source, checked 2026-11-05):
//   - AIOStreams images.ts resolves GET /Users/:id/Images/Primary to
//     userData.jellyfin.primary.avatar (personas: userData.jellyfin.personas[].avatar).
//   - AIOMetadata profiles.ts resolves its default profile to
//     config.jellyfinUserAvatar (per-user entries: config.jellyfinUsers[].avatar).
// So a write goes through each product's own config write path with the avatar
// URL stored in that field. avatarOf on both sides requires ^https?://, so
// only a public image link is valid; uploads cannot be hosted in v1.
//
// IO is injected so the pure path logic stays unit-testable without the store
// imports the real utils carry.

import { verifyAIOStreamsWriteReadback, AIOSTREAMS_SERVER_REWRITTEN_KEYS, AIOStreamsAccessKeyError } from '../aiostreams-config-safety.ts'
import { verifyAIOMetadataWriteReadback, AIOMETADATA_SERVER_REWRITTEN_KEYS } from '../aiometadata-config-safety.ts'
import { isValidAvatarHttpsUrl } from './avatar-value.ts'

/** Sets or removes userData.jellyfin.primary.avatar on an AIOStreams config (pure). */
export function applyAIOStreamsAvatar(userData: Record<string, unknown>, avatarUrl: string | null): Record<string, unknown> {
    const next = JSON.parse(JSON.stringify(userData)) as Record<string, unknown>
    const jellyfin = (next.jellyfin ?? {}) as Record<string, unknown>
    const primary = (jellyfin.primary ?? {}) as Record<string, unknown>
    if (avatarUrl === null || avatarUrl === '') delete primary.avatar
    else primary.avatar = avatarUrl
    jellyfin.primary = primary
    next.jellyfin = jellyfin
    return next
}

/** Reads userData.jellyfin.primary.avatar (only http(s) strings count, upstream rule). */
export function readAIOStreamsAvatar(userData: unknown): { marker: string; thumbUrl: string | null } {
    const avatar = (userData as { jellyfin?: { primary?: { avatar?: unknown } } })?.jellyfin?.primary?.avatar
    const marker = typeof avatar === 'string' && /^https?:\/\//i.test(avatar.trim()) ? avatar.trim() : ''
    return { marker, thumbUrl: marker || null }
}

/** Sets or removes config.jellyfinUserAvatar on an AIOMetadata config (pure). */
export function applyAIOMetadataAvatar(config: Record<string, unknown>, avatarUrl: string | null): Record<string, unknown> {
    const next = JSON.parse(JSON.stringify(config)) as Record<string, unknown>
    if (avatarUrl === null || avatarUrl === '') delete next.jellyfinUserAvatar
    else next.jellyfinUserAvatar = avatarUrl
    return next
}

/** Reads config.jellyfinUserAvatar (only http(s) strings count, upstream rule). */
export function readAIOMetadataAvatar(config: unknown): { marker: string; thumbUrl: string | null } {
    const avatar = (config as { jellyfinUserAvatar?: unknown })?.jellyfinUserAvatar
    const marker = typeof avatar === 'string' && /^https?:\/\//i.test(avatar.trim()) ? avatar.trim() : ''
    return { marker, thumbUrl: marker || null }
}

export interface FacadeAvatarIO {
    fetch: () => Promise<Record<string, unknown>>
    write: (next: Record<string, unknown>) => Promise<void>
    /** Raw re-fetch after the write; success is only reported once the readback verifies. */
    readback?: () => Promise<Record<string, unknown>>
}

export type FacadeWriteOutcome = { ok: true; marker: string } | { ok: false; message: string; conflict?: boolean; rejection?: FacadeWriteRejection }

/** Structured rejection code a facade write preserves from a typed failure (SOL 10). */
export const FACADE_ACCESS_KEY_REJECTION = 'AIOS_INSTANCE_ACCESS_KEY_REQUIRED' as const
export type FacadeWriteRejection = typeof FACADE_ACCESS_KEY_REJECTION

/**
 * SOL 10: true only for a proven AIOStreams instance access-key rejection
 * (upstream ADDON_PASSWORD_INVALID mapped to AIOStreamsAccessKeyError, or a
 * facade outcome preserving that code). A local proxy 401, a config-password
 * rejection or a text match is never a key rejection, so the vault entry stays.
 */
export function isAIOStreamsAccessKeyRejection(err: unknown): boolean {
    if (err instanceof AIOStreamsAccessKeyError) return true
    return typeof err === 'object' && err !== null
        && (err as { rejection?: unknown }).rejection === FACADE_ACCESS_KEY_REJECTION
}

// The upstream PUTs are last-write-wins with no concurrency guard, so avatar
// writes to the same instance serialize here and revalidate afterwards.
const facadeWriteChains = new Map<string, Promise<unknown>>()

export function serializeFacadeWrite<T>(key: string | undefined, run: () => Promise<T>): Promise<T> {
    if (!key) return run()
    const prev = facadeWriteChains.get(key) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(run)
    facadeWriteChains.set(key, next)
    next.finally(() => {
        if (facadeWriteChains.get(key) === next) facadeWriteChains.delete(key)
    }).catch(() => {})
    return next
}

const AVATAR_URL_REJECTED = 'The picture must be a public https image link with a real host.'

/**
 * CP-R2-005: every avatar value is re-checked at the transport boundary. A
 * restored or programmatically built spec can bypass the UI planner, so the
 * allowlist holds here too; removal (null) always stays valid.
 */
function assertTransportAvatarUrl(avatarUrl: string | null): string | null {
    if (avatarUrl === null) return null
    if (!isValidAvatarHttpsUrl(avatarUrl)) throw new Error(AVATAR_URL_REJECTED)
    return avatarUrl
}

/** Read-modify-write of the AIOStreams user config with only the avatar field swapped. */
export async function writeAIOStreamsAvatar(io: FacadeAvatarIO, avatarUrl: string | null, options: { instanceKey?: string } = {}): Promise<FacadeWriteOutcome> {
    return serializeFacadeWrite(options.instanceKey, async () => {
        try {
            const target = assertTransportAvatarUrl(avatarUrl)
            const userData = await io.fetch()
            const next = applyAIOStreamsAvatar(userData, target)
            await io.write(next)
            if (io.readback) {
                const readback = await io.readback()
                const read = readAIOStreamsAvatar(readback)
                const expected = target === null || target === '' ? '' : target
                if (read.marker !== expected) {
                    return { ok: false as const, message: 'The AIOStreams picture did not persist; it may have been changed elsewhere. Reload and try again.', conflict: true }
                }
                const preservedFields = Object.keys(userData).filter(key => key !== 'jellyfin' && !(AIOSTREAMS_SERVER_REWRITTEN_KEYS as readonly string[]).includes(key))
                const verification = verifyAIOStreamsWriteReadback({ planned: next, readback, fields: ['jellyfin'], preWrite: userData, preservedFields })
                if (!verification.ok) {
                    const detail = verification.mismatchedFields.length > 0 ? `changed fields: ${verification.mismatchedFields.join(', ')}` : `lost fields: ${verification.lostFields.join(', ')}`
                    return { ok: false as const, message: `The AIOStreams config changed elsewhere during the write (${detail}). Reload the instance and reapply the picture.`, conflict: true }
                }
            }
            return { ok: true as const, marker: avatarUrl === null || avatarUrl === '' ? '' : avatarUrl }
        } catch (err) {
            return {
                ok: false as const,
                message: err instanceof Error ? err.message : 'AIOStreams avatar write failed',
                rejection: err instanceof AIOStreamsAccessKeyError ? FACADE_ACCESS_KEY_REJECTION : undefined,
            }
        }
    })
}

/** Read-modify-write of the AIOMetadata config with only the avatar field swapped. */
export async function writeAIOMetadataAvatar(io: FacadeAvatarIO, avatarUrl: string | null, options: { instanceKey?: string } = {}): Promise<FacadeWriteOutcome> {
    return serializeFacadeWrite(options.instanceKey, async () => {
        try {
            const target = assertTransportAvatarUrl(avatarUrl)
            const config = await io.fetch()
            const next = applyAIOMetadataAvatar(config, target)
            await io.write(next)
            if (io.readback) {
                const readback = await io.readback()
                const read = readAIOMetadataAvatar(readback)
                const expected = target === null || target === '' ? '' : target
                if (read.marker !== expected) {
                    return { ok: false as const, message: 'The AIOMetadata picture did not persist; the config may have changed elsewhere. Reload and try again.', conflict: true }
                }
                const protectedPaths = Object.keys(config).filter(key => key !== 'jellyfinUserAvatar' && !(AIOMETADATA_SERVER_REWRITTEN_KEYS as readonly string[]).includes(key))
                const verification = verifyAIOMetadataWriteReadback({ planned: next, readback, fields: ['jellyfinUserAvatar'], preWrite: config, protectedPaths })
                if (!verification.ok) {
                    const detail = verification.mismatchedFields.length > 0 ? `changed fields: ${verification.mismatchedFields.join(', ')}` : `lost fields: ${verification.lostFields.join(', ')}`
                    return { ok: false as const, message: `The AIOMetadata config changed elsewhere during the write (${detail}). Reload the instance and reapply the picture.`, conflict: true }
                }
            }
            return { ok: true as const, marker: avatarUrl === null || avatarUrl === '' ? '' : avatarUrl }
        } catch (err) {
            return { ok: false as const, message: err instanceof Error ? err.message : 'AIOMetadata avatar write failed' }
        }
    })
}

/**
 * Capability switch for the facade avatar rows. The field names above are
 * verified against the pinned upstream sources, so writes ship enabled;
 * flipping this to false renders both rows read-only without code changes.
 */
export const FACADE_AVATAR_WRITE_ENABLED = true

// Secret handling (CP-R2-001, revised CP-R3-001) ----------------------------
//
// AIOStreams gates writes (not reads) on config.accessKey and exposes no
// read-only or dry-run way to prove a key, so entering the key only unlocks
// the row: the user-confirmed avatar write IS the check, and an auth-style
// rejection relocks the row with nothing changed (the PUT was refused).
// AIOMetadata decrypts its config with the addon password on load, so its
// probe stays a plain authenticated READ.

/**
 * CP-R3-001: maps an auth-style facade write rejection (access key required,
 * ADDON_PASSWORD_INVALID, 401/403, decrypt failure) to the key-rejected user
 * message. Returns null when the failure is not about the key.
 */
export function facadeAuthRejectionMessage(message: string): string | null {
    return /access key|addon password|invalid password|unauthorized|\b401\b|\b403\b|decrypt|ADDON_PASSWORD_INVALID/i.test(message)
        ? 'The instance rejected this key, so nothing was changed. Enter the correct key and try again.'
        : null
}

/** Proves an AIOMetadata addon password with a harmless authenticated load. */
export async function probeAIOMetadataAddonPassword(
    load: () => Promise<Record<string, unknown>>,
): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
        await load()
        return { ok: true as const }
    } catch (err) {
        return { ok: false as const, message: err instanceof Error ? err.message : 'The AIOMetadata instance rejected this password' }
    }
}
