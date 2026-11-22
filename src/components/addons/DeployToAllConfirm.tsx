import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { useMaskedAccountLabel } from '@/hooks/useMaskedAccountLabel'
import { deployListToggle, deployPreview, deployToAllCopy } from '@/lib/deploy-to-all'
import { cn } from '@/lib/utils'
import type { Account } from '@/types/account'

interface DeployToAllConfirmProps {
    addonLabel: string
    targets: Account[] | null
    onCancel: () => void
    onConfirm: () => void
}

export function DeployToAllConfirm({ addonLabel, targets, onCancel, onConfirm }: DeployToAllConfirmProps) {
    const maskedAccountLabel = useMaskedAccountLabel()
    const lastTargets = useRef<Account[]>([])
    if (targets && targets.length > 0) lastTargets.current = targets
    const list = targets ?? lastTargets.current
    const copy = deployToAllCopy(addonLabel, list.length)
    const [expanded, setExpanded] = useState(false)
    const open = !!targets && targets.length > 0
    const [wasOpen, setWasOpen] = useState(open)
    if (wasOpen !== open) {
        setWasOpen(open)
        if (open) setExpanded(false)
    }
    const { shown } = deployPreview(list, expanded)
    const hidden = deployPreview(list).more
    const toggle = deployListToggle(hidden, list.length, expanded)
    const listId = useId()
    const [listEl, setListEl] = useState<HTMLUListElement | null>(null)
    const [listScrolls, setListScrolls] = useState(false)
    useLayoutEffect(() => {
        if (!listEl) return
        const check = () => setListScrolls(listEl.scrollHeight > listEl.clientHeight + 1)
        check()
        const observer = new ResizeObserver(check)
        observer.observe(listEl)
        return () => observer.disconnect()
    }, [listEl, shown.length])

    return (
        <ConfirmationDialog
            open={open}
            onOpenChange={open => { if (!open) onCancel() }}
            severity="info"
            title={copy.title}
            description={copy.description}
            confirmText={copy.confirmText}
            onConfirm={onConfirm}
            details={list.length > 0 && (
                <div data-theme-part="panel" className={cn('mt-4 flex w-full flex-col rounded-2xl border border-border/40 bg-muted/25 p-3 text-left', shown.length > 4 ? 'min-h-[9rem]' : 'shrink-0')}>
                    <div className="mb-2 shrink-0 text-xs font-medium text-muted-foreground">Accounts</div>
                    <ul
                        ref={setListEl}
                        id={listId}
                        tabIndex={listScrolls ? 0 : undefined}
                        className={cn('grid min-h-0 grid-cols-2 gap-x-3 gap-y-2 overflow-y-auto overscroll-contain rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', listScrolls && 'pr-1')}
                        aria-label="Accounts it will be added to"
                    >
                        {shown.map(account => (
                            <li key={account.id} className="flex min-w-0 items-center gap-2">
                                <AccountAvatar account={account} size="xs" showStatus={false} />
                                <span className="min-w-0 truncate text-xs font-medium text-foreground">{maskedAccountLabel(account)}</span>
                            </li>
                        ))}
                    </ul>
                    {hidden > 0 && (
                        <button
                            type="button"
                            aria-expanded={expanded}
                            aria-controls={listId}
                            onClick={() => setExpanded(value => !value)}
                            className="mt-2 shrink-0 self-start rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {toggle.label}
                        </button>
                    )}
                    <span className="sr-only" aria-live="polite">{toggle.announcement}</span>
                </div>
            )}
        />
    )
}
