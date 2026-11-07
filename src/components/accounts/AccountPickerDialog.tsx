import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { Button, type ButtonProps } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAccountStore, getAccountEmail } from '@/store/accountStore'
import { accountMatchesQuery } from '@/lib/account-compat'
import { useUIStore } from '@/store/uiStore'
import { maskNameLevel, maskEmailLevel } from '@/lib/utils'
import { User, Search, X, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'

interface AccountPickerDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    description: string
    onConfirm: (accountIds: string[]) => Promise<void>
    confirmLabel?: string
    confirmPendingLabel?: string
    confirmVariant?: ButtonProps['variant']
    renderPreview?: (accountIds: string[]) => ReactNode
    // Accounts never offered as targets, e.g. the source of a clone or move.
    excludeAccountIds?: string[]
}

export function AccountPickerDialog({
    open,
    onOpenChange,
    title,
    description,
    onConfirm,
    confirmLabel = 'Confirm',
    confirmPendingLabel,
    confirmVariant = 'default',
    renderPreview,
    excludeAccountIds,
}: AccountPickerDialogProps) {
    const accounts = useAccountStore((state) => state.accounts)
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const privacyLevelEmail = useUIStore(s => s.privacyLevelEmail)
    const namePrivacy = isPrivacyModeEnabled ? privacyLevelNames : 0
    const emailPrivacy = isPrivacyModeEnabled ? privacyLevelEmail : 0
    const { toast } = useToast()
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [searchQuery, setSearchQuery] = useState('')
    const [loading, setLoading] = useState(false)

    const resetDialogState = useCallback(() => {
        setSelectedIds(new Set())
        setSearchQuery('')
    }, [])

    useEffect(() => {
        if (!open) {
            resetDialogState()
        }
    }, [open, resetDialogState])

    const filteredAccounts = useMemo(() => {
        const excluded = new Set(excludeAccountIds ?? [])
        const pool = excluded.size > 0 ? accounts.filter(acc => !excluded.has(acc.id)) : accounts
        if (!searchQuery.trim()) return pool
        return pool.filter(acc => accountMatchesQuery(acc, searchQuery))
    }, [accounts, searchQuery, excludeAccountIds])

    const selectedAccountIds = useMemo(() => Array.from(selectedIds), [selectedIds])

    const toggleAccount = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const handleSelectAll = () => {
        if (selectedIds.size === filteredAccounts.length) {
            setSelectedIds(new Set())
        } else {
            setSelectedIds(new Set(filteredAccounts.map(a => a.id)))
        }
    }

    const handleOpenChange = (nextOpen: boolean) => {
        if (!nextOpen) {
            resetDialogState()
        }
        onOpenChange(nextOpen)
    }

    const handleConfirm = async () => {
        setLoading(true)
        try {
            await onConfirm(Array.from(selectedIds))
            handleOpenChange(false)
        } catch (error) {
            toast({
                title: `${confirmLabel} failed`,
                description: error instanceof Error ? error.message : 'Unknown error',
                variant: 'destructive',
            })
        } finally {
            setLoading(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>

                <div className="min-w-0 space-y-4 py-4">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Search accounts..."
                            className="pl-10"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                        {searchQuery && (
                            <Button
                                variant="ghost"
                                size="icon"
                                className="absolute right-1 top-1/2 transform -translate-y-1/2 h-7 w-7 flex items-center justify-center"
                                onClick={() => setSearchQuery('')}
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        )}
                    </div>

                    <div className="flex items-center justify-between px-2">
                        <Label className="text-xs font-medium text-muted-foreground">
                            {selectedIds.size} account{selectedIds.size !== 1 ? 's' : ''} selected
                        </Label>
                        <Button variant="link" size="sm" onClick={handleSelectAll} className="h-auto p-0 text-xs">
                            {selectedIds.size === filteredAccounts.length ? 'Deselect All' : 'Select All'}
                        </Button>
                    </div>

                    <ScrollArea data-theme-part="panel" className="h-64 rounded-md border p-2">
                        <div className="space-y-1">
                            {filteredAccounts.map((account) => (
                                <label
                                    key={account.id}
                                    className="flex items-center gap-3 p-2 hover:bg-muted/50 rounded-md cursor-pointer transition-colors"
                                >
                                    <Checkbox
                                        checked={selectedIds.has(account.id)}
                                        onCheckedChange={() => toggleAccount(account.id)}
                                    />
                                    <div className="flex items-center gap-2 min-w-0">
                                        <AccountAvatar account={account} size="sm" />
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <p className="text-sm font-medium truncate">{maskNameLevel(account.name, namePrivacy)}</p>
                                            </div>
                                            <p className="text-xs text-muted-foreground truncate">{maskEmailLevel(getAccountEmail(account) || '', emailPrivacy)}</p>
                                        </div>
                                    </div>
                                </label>
                            ))}
                            {filteredAccounts.length === 0 && (
                                <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                                    <div className="rounded-full bg-muted/50 p-3 text-muted-foreground">
                                        <User className="h-6 w-6" />
                                    </div>
                                    <p className="text-sm text-muted-foreground">No accounts found</p>
                                </div>
                            )}
                        </div>
                    </ScrollArea>

                    {renderPreview && selectedAccountIds.length > 0 && (
                        <div className="min-w-0">
                            {renderPreview(selectedAccountIds)}
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="subtle" onClick={() => handleOpenChange(false)} disabled={loading}>
                        Cancel
                    </Button>
                    <Button variant={confirmVariant} onClick={handleConfirm} disabled={selectedIds.size === 0 || loading} className="gap-2">
                        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                        {loading ? (confirmPendingLabel ?? confirmLabel) : confirmLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
