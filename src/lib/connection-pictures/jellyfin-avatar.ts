// Jellyfin (native servers only) user-picture read/write driver.
//
// Version-aware route pick per the build spec: POST/DELETE /UserImage?userId=
// on 12.x (and 11.x), legacy /Users/{id}/Images/Primary on 10.x and whenever
// the server version is unknown (the legacy route stays served on 12.x).
// The POST body is the base64 TEXT of the image bytes with an image/* content
// type; the server base64-decodes it (Jellyfin ImageController).
//
// A 403 on write means the user's policy forbids preference edits; callers
// map it to a locked Can't change row. Never log tokens or image bytes.

import { createJellyfinClient, JellyfinError, jellyfinAuthHeaderValue, normalizeJellyfinUrl } from '../jellyfin/client.ts'
import { bytesToBase64 } from '../base64.ts'
import { isAllowedAvatarImageMime, AVATAR_UPLOAD_MAX_BYTES } from './avatar-value.ts'

export interface JellyfinAvatarContext {
    baseUrl: string
    accessToken: string
    deviceId: string
    userId: string
    /** MediaServerIdentity.version; empty when unknown. */
    serverVersion?: string
}

export type JellyfinImageRoute = 'user-image' | 'legacy'

/** 12+ (and 11) use /UserImage; 10.x and unknown versions use the legacy route. */
export function pickJellyfinImageRoute(serverVersion?: string): JellyfinImageRoute {
    const match = String(serverVersion ?? '').trim().match(/^(\d+)/)
    if (!match) return 'legacy'
    const major = Number(match[1])
    return Number.isFinite(major) && major >= 11 ? 'user-image' : 'legacy'
}

export interface JellyfinAvatarRead {
    /** PrimaryImageTag, or null when the user has no picture. */
    tag: string | null
    /** Browser-loadable image URL for thumbnails (no token embedded). */
    thumbUrl: string | null
    route: JellyfinImageRoute
}

function imageUrlFor(ctx: JellyfinAvatarContext, route: JellyfinImageRoute, tag?: string): string {
    const base = normalizeJellyfinUrl(ctx.baseUrl)
    const params = new URLSearchParams()
    if (tag) params.set('tag', tag)
    const query = params.toString()
    if (route === 'user-image') {
        return `${base}/UserImage?userId=${encodeURIComponent(ctx.userId)}${query ? '&' + query : ''}`
    }
    return `${base}/Users/${encodeURIComponent(ctx.userId)}/Images/Primary${query ? '?' + query : ''}`
}

/** Reads the user DTO for PrimaryImageTag (the byteless picture marker). */
export async function readJellyfinAvatar(ctx: JellyfinAvatarContext): Promise<JellyfinAvatarRead> {
    const route = pickJellyfinImageRoute(ctx.serverVersion)
    const client = createJellyfinClient(ctx.baseUrl, { deviceId: ctx.deviceId })
    const user = await client.getUser(ctx.accessToken, ctx.userId)
    const tag = typeof user.PrimaryImageTag === 'string' && user.PrimaryImageTag !== '' ? user.PrimaryImageTag : null
    return { tag, thumbUrl: tag ? imageUrlFor(ctx, route, tag) : null, route }
}

/**
 * Downloads the current picture bytes for the undo snapshot. A missing
 * picture (404) resolves to null; transport failures propagate to the caller
 * (undo then degrades but sync still proceeds only when the caller allows).
 */
export async function fetchJellyfinAvatarBytes(
    ctx: JellyfinAvatarContext,
    options: { fetch?: typeof fetch } = {},
): Promise<{ base64: string; mime: string } | null> {
    const route = pickJellyfinImageRoute(ctx.serverVersion)
    const url = imageUrlFor(ctx, route)
    const fetchFn = options.fetch ?? globalThis.fetch
    const res = await fetchFn(url, {
        headers: { Authorization: jellyfinAuthHeaderValue(ctx.deviceId, ctx.accessToken) },
        signal: AbortSignal.timeout(20000),
    })
    if (res.status === 404) return null
    if (!res.ok) return null
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength === 0) return null
    return { base64: bytesToBase64(buf), mime }
}

export type JellyfinWriteOutcome =
    | { ok: true }
    | { ok: false; reason: 'forbidden' }
    | { ok: false; reason: 'error'; message: string }

/** CP-R2-005: uploads accept bounded raster payloads only, enforced at the transport boundary. */
function jellyfinUploadAllowed(image: { base64: string; mime: string }): boolean {
    return isAllowedAvatarImageMime(image.mime)
        && image.base64.length > 0
        && Math.floor(image.base64.length * 3 / 4) <= AVATAR_UPLOAD_MAX_BYTES
}

/** Writes a new Primary picture (base64 + image/* content type, version-aware route). */
export async function writeJellyfinAvatar(
    ctx: JellyfinAvatarContext,
    image: { base64: string; mime: string },
): Promise<JellyfinWriteOutcome> {
    if (!jellyfinUploadAllowed(image)) {
        return { ok: false, reason: 'error', message: 'The picture must be a png, jpeg, webp or gif image within the size limit' }
    }
    const route = pickJellyfinImageRoute(ctx.serverVersion)
    const client = createJellyfinClient(ctx.baseUrl, { deviceId: ctx.deviceId })
    try {
        await client.setUserImage(ctx.accessToken, ctx.userId, { base64: image.base64, contentType: image.mime }, route)
        return { ok: true }
    } catch (err) {
        if (err instanceof JellyfinError && err.kind === 'auth' && err.status === 403) return { ok: false, reason: 'forbidden' }
        return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'Jellyfin write failed' }
    }
}

/** Removes the picture (restores the server default). 404 already-removed counts as removed. */
export async function removeJellyfinAvatar(ctx: JellyfinAvatarContext): Promise<JellyfinWriteOutcome> {
    const route = pickJellyfinImageRoute(ctx.serverVersion)
    const client = createJellyfinClient(ctx.baseUrl, { deviceId: ctx.deviceId })
    try {
        await client.deleteUserImage(ctx.accessToken, ctx.userId, route)
        return { ok: true }
    } catch (err) {
        if (err instanceof JellyfinError && err.kind === 'auth' && err.status === 403) return { ok: false, reason: 'forbidden' }
        return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'Jellyfin remove failed' }
    }
}

/** Splits a data URL into base64 payload + mime for the Jellyfin upload. */
export function dataUrlToJellyfinImage(dataUrl: string): { base64: string; mime: string } | null {
    const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
    if (!match) return null
    return { mime: match[1].toLowerCase(), base64: match[2] }
}

/** Decodes stored undo bytes back to an upload payload. */
export function undoBytesToJellyfinImage(previousBase64: string | null, previousMime: string | null): { base64: string; mime: string } | null {
    if (!previousBase64) return null
    return { base64: previousBase64, mime: previousMime || 'image/png' }
}
