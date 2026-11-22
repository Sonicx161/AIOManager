import { forwardRef, useMemo, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Bell, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { useAccountStore } from '@/store/accountStore'
import { useMaskedAccountLabel } from '@/hooks/useMaskedAccountLabel'
import { useNoticesBadgeCount, useNoticesList, useNoticesNewIds } from '@/hooks/useAccountNotices'
import { toNoticeRows } from '@/lib/account-notices'

export const NOTICES_TITLE = 'Notices from this instance'
const NOTICES_INTRO = "Changes this instance's host made to your account."

// Expands instead of popping when notices arrive after Settings is already on screen.
export function NoticesReveal({ show, className, children }: { show: boolean; className?: string; children: ReactNode }) {
    const reduceMotion = useReducedMotion() === true
    return (
        <AnimatePresence initial={false}>
            {show && (
                <motion.div
                    key="notices"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.36, ease: [0.38, 0.8, 0.32, 1.07] }}
                    className={cn('overflow-hidden', className)}
                >
                    {children}
                </motion.div>
            )}
        </AnimatePresence>
    )
}

export function AccountNoticesList({ heading }: { heading?: ReactNode }) {
    const notices = useNoticesList()
    const newIds = useNoticesNewIds()
    const accounts = useAccountStore(s => s.accounts)
    const maskLabel = useMaskedAccountLabel()
    const rows = useMemo(() => toNoticeRows(notices, accounts, newIds), [notices, accounts, newIds])

    if (rows.length === 0) return null

    return (
        <>
            {heading}
            <div data-theme-part="panel" className="rounded-[1.75rem] border border-border/45 bg-card/80 p-4 sm:p-5 lg:p-6 shadow-sm">
                <p className="mb-3 text-sm text-muted-foreground">{NOTICES_INTRO}</p>
                <ul className="min-w-0">
                    {rows.map((row, index) => (
                        <li key={row.id} className={cn('flex items-start gap-3 py-3', index === 0 ? 'pt-0' : 'border-t border-border/40', index === rows.length - 1 && 'pb-0')}>
                            <span aria-hidden className={cn('mt-2 h-2 w-2 shrink-0 rounded-full', row.isNew ? 'bg-primary' : 'bg-transparent')} />
                            <div className="min-w-0 flex-1">
                                <p className="break-words text-sm font-medium leading-snug">
                                    {row.isNew && <span className="sr-only">New: </span>}
                                    {row.text}
                                </p>
                                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                                    <span>{row.dateText}</span>
                                    <span aria-hidden>{'·'}</span>
                                    {row.account ? (
                                        <span className="flex min-w-0 items-center gap-1.5">
                                            <AccountAvatar account={row.account} size="xs" className="h-5 w-5" showStatus={false} />
                                            <span className="truncate">{maskLabel(row.account)}</span>
                                        </span>
                                    ) : (
                                        <span>From the instance Dashboard</span>
                                    )}
                                </p>
                            </div>
                        </li>
                    ))}
                </ul>
            </div>
        </>
    )
}

export const AccountNoticesRootRow = forwardRef<HTMLButtonElement, { onOpen: () => void }>(function AccountNoticesRootRow({ onOpen }, ref) {
    const unseenCount = useNoticesBadgeCount()
    return (
        <section className="mt-4">
            <div className="rounded-2xl border border-border/45 bg-card/80 px-2.5 py-1 shadow-sm">
                <button
                    ref={ref}
                    type="button"
                    onClick={onOpen}
                    className="flex min-h-[48px] w-full items-center gap-3 rounded-xl px-1.5 py-2.5 text-left transition-colors hover:bg-muted/25"
                >
                    <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/35 text-muted-foreground">
                        <Bell className="h-[15px] w-[15px]" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{NOTICES_TITLE}</span>
                    {unseenCount > 0 && (
                        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold tabular-nums text-primary-foreground">
                            {unseenCount}
                            <span className="sr-only"> new</span>
                        </span>
                    )}
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
                </button>
            </div>
        </section>
    )
})
