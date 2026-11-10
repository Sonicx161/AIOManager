import { useEffect, useState } from 'react'
import { Tooltip } from '@/components/ui/tooltip'
import { Account } from '@/types/account'
import { cn, maskNameLevel } from '@/lib/utils'
import { useUIStore } from '@/store/uiStore'
import { useSyncStore } from '@/store/syncStore'
import { avatarSigner, isRemoteAvatar } from '@/lib/image-proxy'
import { sanitizeServerImageSrc } from '@/lib/connection-pictures/avatar-value'

type Size = 'xs' | 'sm' | 'md' | 'lg'

interface AccountAvatarProps {
    account: Pick<Account, 'name' | 'email' | 'emoji' | 'avatar'> & Partial<Pick<Account, 'status'>>
    size?: Size
    showStatus?: boolean
    pulse?: boolean
    className?: string
    /** Account accent color; drawn as a 1px ring above the photo and below the status dot. */
    accentColor?: string | null
}

const SIZE_MAP: Record<Size, { box: string; letter: string; emoji: string; dot: string }> = {
    xs: { box: 'w-6 h-6', letter: 'text-xs', emoji: 'text-xs', dot: 'w-2 h-2' },
    sm: { box: 'w-8 h-8', letter: 'text-xs', emoji: 'text-sm', dot: 'w-2 h-2' },
    md: { box: 'w-9 h-9', letter: 'text-sm', emoji: 'text-base', dot: 'w-2.5 h-2.5' },
    lg: { box: 'w-10 h-10', letter: 'text-sm', emoji: 'text-lg', dot: 'w-2.5 h-2.5' },
}

const STATUS_TEXT: Record<string, string> = {
    active: 'Active',
    expired: 'Session Expired',
    error: 'Error',
}

const STATUS_BG: Record<string, string> = {
    active: 'bg-success',
    expired: 'bg-warning',
    error: 'bg-destructive',
}

/**
 * SOL 3: remote avatars render through the signed proxy when a sync session
 * can sign it. Without an authenticated session the signer cannot produce a
 * URL (it returns null), so the validated http(s) URL renders directly instead
 * of losing a saved avatar on local-only installs. The direct fallback never
 * applies while signed in, keeping the proxy privacy promise there.
 */
export function resolveAccountAvatarSrc(
    avatar: string | null | undefined,
    state: { signedSrc: string | null; hasSyncSession: boolean },
): string | null {
    if (!avatar) return null
    if (!isRemoteAvatar(avatar)) return avatar
    if (state.signedSrc) return state.signedSrc
    if (!state.hasSyncSession) return sanitizeServerImageSrc(avatar)
    return null
}

export function AccountAvatar({
    account,
    size = 'md',
    showStatus,
    pulse,
    className,
    accentColor,
}: AccountAvatarProps) {
    const dim = SIZE_MAP[size]
    const privacyLevel = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelNames : 0))
    const initial = maskNameLevel(account.name || account.email || '?', privacyLevel)[0]?.toUpperCase()
    const status = account.status as string | undefined
    const shouldShowStatus = showStatus ?? !!status
    const isPulsing = pulse ?? status === 'active'

    const [avatarFailed, setAvatarFailed] = useState(false)
    const [signedSrc, setSignedSrc] = useState<string | null>(null)
    const hasSyncSession = useSyncStore(s => s.auth.isAuthenticated)
    useEffect(() => {
        const avatar = account.avatar
        setSignedSrc(null)
        if (!avatar || !isRemoteAvatar(avatar)) return
        // Without an authenticated session the signer answers null anyway, so
        // go straight to the direct fallback; signing in re-runs this effect
        // and retries the sign request.
        if (!hasSyncSession) return
        let live = true
        void avatarSigner.get(avatar).then(src => { if (live) setSignedSrc(src) })
        return () => { live = false }
    }, [account.avatar, hasSyncSession])
    const avatarSrc = resolveAccountAvatarSrc(account.avatar, { signedSrc, hasSyncSession })
    // A failure belongs to one source: a new source (signed in, signed out, new avatar) gets a fresh try.
    useEffect(() => { setAvatarFailed(false) }, [avatarSrc])
    const showAvatar = !!avatarSrc && !avatarFailed

    return (
        <div
            data-theme-part="account-avatar"
            className={cn('relative isolate shrink-0 flex items-center justify-center rounded-xl', dim.box, className)}
        >
            {/* Same muted backdrop the global SquircleOverlay paints, kept local so skins
                can suppress the fixed squircle clip with --theme-avatar-filter and apply
                the theme radius instead. Inner-surface radius comes from the shared theme
                STATE_DETAILS (border-radius: inherit) via the account-avatar-* hooks. */}
            <div
                data-theme-part="account-avatar-surface"
                className="absolute inset-0 rounded-[inherit] bg-muted"
                style={{ filter: 'var(--theme-avatar-filter, url(#squircle))' }}
            />
            {showAvatar ? (
                <img
                    src={avatarSrc ?? undefined}
                    referrerPolicy="no-referrer"
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={() => { if (account.avatar) avatarSigner.invalidate(account.avatar); setAvatarFailed(true) }}
                    data-theme-part="account-avatar-image"
                    className="absolute inset-0 h-full w-full rounded-[inherit] object-cover z-10"
                    style={{ filter: 'var(--theme-avatar-filter, url(#squircle))' }}
                />
            ) : (
                <span aria-hidden="true" className={cn('relative z-10 leading-none', dim.emoji)}>
                    {account.emoji ? account.emoji : (
                        <span className={cn('font-bold text-muted-foreground', dim.letter)}>
                            {initial}
                        </span>
                    )}
                </span>
            )}
            {accentColor && (
                <span
                    data-theme-part="account-accent"
                    className="pointer-events-none absolute inset-0 z-[15] rounded-xl"
                    style={{ boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accentColor} 65%, transparent)` }}
                    aria-hidden="true"
                />
            )}
            {shouldShowStatus && status && (
                <Tooltip content={STATUS_TEXT[status] || status} side="top">
                    <span
                        className={cn('absolute -bottom-1 -right-1 box-content rounded-full border-2 border-card bg-card z-20', dim.dot)}
                        aria-label={`Account status: ${status}`}
                    >
                        <span className={cn('block h-full w-full rounded-full', STATUS_BG[status] || 'bg-muted-foreground/60', isPulsing && 'animate-pulse')} />
                    </span>
                </Tooltip>
            )}
        </div>
    )
}

export function AccountMenuHeader({ account, name }: { account: AccountAvatarProps['account']; name: string }) {
    return (
        <>
            <AccountAvatar account={account} size="md" />
            <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{name}</p>
                <p className="text-xs text-muted-foreground">Manage account</p>
            </div>
        </>
    )
}
