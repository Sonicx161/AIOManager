import { memo } from 'react'
import { AlertTriangle, CloudUpload, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Account } from '@/types/account'
import { useStremioSyncRepair } from '@/hooks/useStremioSyncRepair'
import { cn } from '@/lib/utils'

interface StremioCredentialRepairNoticeProps {
    account: Account
    className?: string
}

// Shared split-brain warning + guarded manual repair for the two API-key surfaces
// (the settings ApiKeysSection row and the providers ApiKeyManager panel). The copy
// here is the single source of truth for both locations. The repair reuses the
// existing credential upload (syncCredentialsToServer) with all of its ownership and
// vault guards, reports success only from the authoritative
// serverStremioCredentialedAccounts readback, and never rotates the API key.
export const StremioCredentialRepairNotice = memo(function StremioCredentialRepairNotice({ account, className }: StremioCredentialRepairNoticeProps) {
    const { isRepairing, repair } = useStremioSyncRepair(account.id)

    return (
        <div className={cn('flex flex-col gap-1.5', className)}>
            <p className="flex items-start gap-1.5 text-xs font-medium text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This server is missing its Stremio sign-in
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">Your API key works, but changes from other apps can’t reach Stremio yet. Repair the connection using your saved sign-in.</p>
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 gap-1.5 text-xs font-semibold"
                    disabled={isRepairing}
                    onClick={repair}
                >
                    {isRepairing
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <CloudUpload className="h-3 w-3" />}
                    {isRepairing ? 'Repairing…' : 'Repair Stremio sync'}
                </Button>
                <p className="text-[11px] text-muted-foreground">Keeps your current API key.</p>
            </div>
        </div>
    )
})
