import { useCallback } from 'react'
import { useUIStore } from '@/store/uiStore'
import { maskAccountLabel } from '@/lib/utils'

/** Account label masked by the current privacy levels; pass an account record, never fall back to its id. */
export function useMaskedAccountLabel() {
    const enabled = useUIStore(s => s.isPrivacyModeEnabled)
    const names = useUIStore(s => s.privacyLevelNames)
    const email = useUIStore(s => s.privacyLevelEmail)
    const nameLevel = enabled ? names : 0
    const emailLevel = enabled ? email : 0
    return useCallback(
        (account: { name?: string | null; email?: string | null } | null | undefined) => maskAccountLabel(account, nameLevel, emailLevel),
        [nameLevel, emailLevel],
    )
}
