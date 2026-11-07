import { memo, useEffect, useState } from 'react'
import { Key, RefreshCw, Eye, EyeOff, AlertCircle, Search, SearchX, X, MoreVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { SquircleOverlay } from '@/components/ui/squircle-overlay'
import { StatusChip } from '@/components/ui/status-chip'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { StremioCredentialRepairNotice } from '@/components/accounts/StremioCredentialRepairNotice'
import { Account } from '@/types/account'
import { useAccountStore, getAccountEmail, getStremioAuthKey } from '@/store/accountStore'
import { useSyncStore } from '@/store/syncStore'
import { useUIStore } from '@/store/uiStore'
import { isSplitBrainAccount } from '@/lib/canonical-visibility'
import { generateAccountApiKey, regenerateAccountApiKey } from '@/lib/account-api-key'
import { maskEmailLevel, maskNameLevel, normalizeForSearch } from '@/lib/utils'

interface ApiKeyRowProps {
    account: Account
    isSplitBrain: boolean
}

const MASKED_BULLETS = '\u2022'.repeat(12)

const ApiKeyRow = memo(function ApiKeyRow({ account, isSplitBrain }: ApiKeyRowProps) {
    const [showKey, setShowKey] = useState(false)
    const [confirmRegenerate, setConfirmRegenerate] = useState(false)
    const isPrivacyMode = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const privacyLevelEmail = useUIStore(s => s.privacyLevelEmail)

    const apiKey = account.apiKey

    // Re-mask whenever the key material changes so a rotated key never stays revealed.
    useEffect(() => {
        setShowKey(false)
    }, [apiKey])

    // Same identity rendering as AccountListRow, honoring each privacy level
    // separately: customized names follow privacyLevelNames while email-shaped
    // names and fallback emails follow privacyLevelEmail.
    const accountEmail = getAccountEmail(account)
    const namePrivacy = isPrivacyMode ? privacyLevelNames : 0
    const emailPrivacy = isPrivacyMode ? privacyLevelEmail : 0
    const rawName = account.name
    const isDefaultName = !rawName || rawName === 'Account' || rawName === 'Stremio Account'
    const isEmailName = !!rawName && rawName.includes('@')

    const displayName = isDefaultName
        ? accountEmail
            ? maskEmailLevel(accountEmail, emailPrivacy)
            : rawName
                ? maskNameLevel(rawName, namePrivacy)
                : 'Unnamed Account'
        : isEmailName
            ? maskEmailLevel(rawName, emailPrivacy)
            : maskNameLevel(rawName, namePrivacy)

    const secondaryEmail = !isDefaultName && !isEmailName && accountEmail
        ? maskEmailLevel(accountEmail, emailPrivacy)
        : ''

    return (
        <div role="listitem" className="flex flex-col gap-2 px-2.5 py-2.5 sm:grid sm:min-h-14 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-center sm:gap-3 sm:px-3">
            <div className="flex min-w-0 items-center gap-2">
                <AccountAvatar account={account} size="sm" showStatus={false} />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-bold leading-tight">{displayName}</p>
                    {secondaryEmail && (
                        <p className="truncate text-xs leading-tight text-muted-foreground/75">{secondaryEmail}</p>
                    )}
                </div>
            </div>

            {apiKey ? (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <StatusChip variant="success" size="sm" className="shrink-0">
                        <span className="h-1.5 w-1.5 rounded-full bg-success" />
                        Active
                    </StatusChip>
                    <div data-theme-part="input" className="flex h-8 min-w-0 flex-1 basis-32 items-center truncate rounded-lg border border-border/30 bg-muted/20 px-2 font-mono text-xs text-muted-foreground">
                        {showKey ? apiKey : `${MASKED_BULLETS}${apiKey.slice(-4)}`}
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowKey(!showKey)}
                        aria-label={showKey ? 'Hide API key' : 'Show API key'}
                    >
                        {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                    <CopyButton value={apiKey} className="h-8 w-8" />
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-muted/45 hover:text-foreground"
                                aria-label={`API key actions for ${displayName}`}
                            >
                                <MoreVertical className="h-3.5 w-3.5" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56 max-w-[calc(100vw-2rem)] z-50">
                            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">API Key</div>
                            <DropdownMenuItem destructive className="gap-2" onClick={() => setConfirmRegenerate(true)}>
                                <RefreshCw className="h-4 w-4 shrink-0" />
                                Regenerate API key
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            ) : (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <StatusChip variant="muted" size="sm" className="shrink-0">
                        No key
                    </StatusChip>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 gap-1.5 text-xs font-semibold"
                        onClick={() => generateAccountApiKey(account.id)}
                    >
                        <Key className="h-3 w-3" />
                        Generate API Key
                    </Button>
                </div>
            )}

            {apiKey && isSplitBrain && (
                <StremioCredentialRepairNotice account={account} className="sm:col-span-2" />
            )}

            {apiKey && (
                <ConfirmationDialog
                    open={confirmRegenerate}
                    onOpenChange={setConfirmRegenerate}
                    title="Regenerate API Key?"
                    description="This will invalidate the current key. Any services using it will lose access until updated with the new key."
                    confirmText="Regenerate"
                    isDestructive
                    onConfirm={() => {
                        regenerateAccountApiKey(account.id)
                        setConfirmRegenerate(false)
                    }}
                />
            )}
        </div>
    )
})

export function ApiKeysSection() {
    const accounts = useAccountStore(s => s.accounts)
    const serverStremioCredentialedAccounts = useSyncStore(s => s.serverStremioCredentialedAccounts)
    const [search, setSearch] = useState('')
    const activeKeyCount = accounts.filter(a => a.apiKey).length

    // Filtering only narrows what renders; it never touches account or key data.
    const normalizedQuery = normalizeForSearch(search.trim())
    const visibleAccounts = normalizedQuery
        ? accounts.filter(account =>
            normalizeForSearch(account.name || '').includes(normalizedQuery) ||
            normalizeForSearch(getAccountEmail(account) || '').includes(normalizedQuery)
        )
        : accounts

    return (
        <section className="space-y-4">
            <div data-theme-part="panel" className="space-y-4 sm:space-y-5 rounded-[1.5rem] sm:rounded-[1.75rem] border border-border/45 bg-card/80 p-3 sm:p-4 md:p-5 lg:p-6 shadow-sm">
                <div className="flex items-start gap-3">
                    <div className="relative mt-0.5 flex h-9 w-9 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-2xl border border-border/35 bg-muted/25">
                        <SquircleOverlay />
                        <Key className="relative z-10 h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 className="text-sm sm:text-base font-semibold">API Keys</h3>
                        <p className="mt-1 text-xs sm:text-sm text-muted-foreground">
                            Per-account keys external services use with your AIOManager URL via the Hydra API.
                        </p>
                    </div>
                </div>

                <div className="space-y-3">
                    {accounts.length === 0 ? (
                        <div data-theme-part="panel" className="flex items-start gap-2 rounded-2xl border border-dashed border-border/40 bg-background/30 p-3 text-xs text-muted-foreground">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                            <span>No accounts yet. Add an account to generate its API key here.</span>
                        </div>
                    ) : (
                        <>
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <p className="text-xs font-semibold text-muted-foreground">Accounts</p>
                                    {activeKeyCount > 0 && (
                                        <span data-theme-part="badge" className="rounded-full bg-primary/12 px-1.5 py-0.5 text-xs font-bold text-primary">
                                            {activeKeyCount} active
                                        </span>
                                    )}
                                    {normalizedQuery && visibleAccounts.length !== accounts.length && (
                                        <span className="text-xs font-medium text-muted-foreground/80">
                                            {visibleAccounts.length} of {accounts.length} accounts
                                        </span>
                                    )}
                                </div>
                                <div className="relative w-full sm:w-64">
                                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
                                    <Input
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                        placeholder="Search accounts"
                                        aria-label="Search accounts by name or email"
                                        className="h-9 pl-8 pr-8 text-xs"
                                    />
                                    {search && (
                                        <button
                                            type="button"
                                            data-theme-part="button"
                                            onClick={() => setSearch('')}
                                            aria-label="Clear account search"
                                            className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-foreground"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>

                            {visibleAccounts.length === 0 ? (
                                <div data-theme-part="panel" className="flex flex-col gap-2 rounded-2xl border border-dashed border-border/40 bg-background/30 p-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                                    <span className="flex items-start gap-2">
                                        <SearchX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                                        No accounts match your search.
                                    </span>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 shrink-0 gap-1.5 text-xs"
                                        onClick={() => setSearch('')}
                                    >
                                        <X className="h-3 w-3" />
                                        Clear search
                                    </Button>
                                </div>
                            ) : (
                                <div role="list" aria-label="Account API keys" data-theme-part="panel" className="divide-y divide-border/25 overflow-hidden rounded-2xl border border-border/35 bg-background/35">
                                    {visibleAccounts.map(account => (
                                        <ApiKeyRow
                                            key={account.id}
                                            account={account}
                                            isSplitBrain={isSplitBrainAccount(account, !!getStremioAuthKey(account), serverStremioCredentialedAccounts)}
                                        />
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </section>
    )
}
