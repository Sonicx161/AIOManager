// One-time avatar heal for already-stored state. Pure mapping with an injected shrink
// so the store can run the shrink off the main thread (worker client) while tests and
// worker-less environments inject the in-process pipeline directly. Only oversized
// data: URIs shrink, https links and compliant avatars are never touched, and a
// replacement is stored only when it is strictly smaller, so a second pass is a no-op.
import { isOversizedAvatarDataUrl } from './avatar-export.ts'

export interface AvatarHeal { id: string; from: string; to: string }

export type AvatarShrinkFn = (dataUrl: string) => Promise<string | null>

export async function healAccountAvatars<T extends { id: string; avatar?: string }>(
    accounts: T[],
    shrink: AvatarShrinkFn,
    shouldCancel?: () => boolean,
): Promise<{ accounts: T[]; changed: boolean; heals: AvatarHeal[]; cancelled: boolean }> {
    const heals: AvatarHeal[] = []
    let next: T[] | null = null
    for (let i = 0; i < accounts.length; i++) {
        // A session that stops being healable aborts between shrinks; partial
        // results are discarded so the caller never writes from a dead session.
        if (shouldCancel?.()) return { accounts, changed: false, heals: [], cancelled: true }
        const avatar = accounts[i].avatar
        if (!isOversizedAvatarDataUrl(avatar)) continue
        const shrunk = await shrink(avatar as string)
        if (shouldCancel?.()) return { accounts, changed: false, heals: [], cancelled: true }
        if (!shrunk || shrunk.length >= (avatar as string).length) continue
        next = next ?? [...accounts]
        next[i] = { ...next[i], avatar: shrunk }
        heals.push({ id: next[i].id, from: avatar as string, to: shrunk })
    }
    return { accounts: next ?? accounts, changed: heals.length > 0, heals, cancelled: false }
}
