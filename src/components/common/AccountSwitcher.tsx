import { useState, useRef, useEffect, useMemo, useId, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, ChevronDown, Search } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { maskNameLevel, maskEmailLevel, normalizeForSearch } from '@/lib/utils'
import { useUIStore } from '@/store/uiStore'

export function maskedDisplayName(name: string, email: string | undefined, privacyLevel: number, emailPrivacyLevel = privacyLevel): string {
    if (name && !name.includes('@')) return maskNameLevel(name, privacyLevel)
    const emailStr = name && name.includes('@') ? name : (email || '')
    return maskEmailLevel(emailStr, emailPrivacyLevel) || name || email || ''
}

interface Account {
    id: string
    name: string
    email?: string
    emoji?: string
    avatar?: string
}

interface PaginationModeProps {
    mode: 'pagination'
    accounts: Account[]
    selectedId: string
    onSelect: (id: string) => void
    onPrev: () => void
    onNext: () => void
    prevLabel?: string
    nextLabel?: string
}

interface FilterModeProps {
    mode: 'filter'
    accounts: Account[]
    selectedId: string | 'all'
    onSelect: (id: string) => void
    allLabel?: string
    placeholder?: string
    buttonClassName?: string
    emptyLabel?: string
    ariaLabel?: string
}

type AccountSwitcherProps = PaginationModeProps | FilterModeProps

const OUTLINE_BTN = "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl text-xs font-medium h-8 px-3 border border-border/40 bg-muted/30 shadow-sm hover:bg-muted/50 hover:text-foreground transition-colors"

export function AccountAvatar({ account, size = 'sm' }: { account: Account; size?: 'sm' | 'md' }) {
    const dim = size === 'sm' ? 'w-5 h-5' : 'w-6 h-6'
    const fontSize = size === 'sm' ? 'text-xs' : 'text-xs'
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const privacyLevelEmail = useUIStore(s => s.privacyLevelEmail)
    const privacyLevel = isPrivacyModeEnabled ? privacyLevelNames : 0
    const emailPrivacy = isPrivacyModeEnabled ? privacyLevelEmail : 0
    const initial = account.emoji || (maskedDisplayName(account.name, account.email, privacyLevel, emailPrivacy)[0] || '?').toUpperCase()
    const [avatarFailed, setAvatarFailed] = useState(false)
    useEffect(() => { setAvatarFailed(false) }, [account.avatar])
    const showAvatar = !!account.avatar && !avatarFailed
    return (
        <div
            data-theme-part="account-avatar"
            className={`relative ${dim} shrink-0 flex items-center justify-center rounded-md`}
        >
            {/* Same muted backdrop the global SquircleOverlay paints, kept local so skins
                can suppress the fixed squircle clip with --theme-avatar-filter and apply
                the theme radius instead (mirrors accounts/AccountAvatar). */}
            <div
                data-theme-part="account-avatar-surface"
                className="absolute inset-0 rounded-[inherit] bg-muted"
                style={{ filter: 'var(--theme-avatar-filter, url(#squircle))' }}
            />
            {showAvatar ? (
                <img
                    src={account.avatar}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={() => setAvatarFailed(true)}
                    data-theme-part="account-avatar-image"
                    className="absolute inset-0 h-full w-full rounded-[inherit] object-cover z-10"
                    style={{ filter: 'var(--theme-avatar-filter, url(#squircle))' }}
                />
            ) : (
                <span className={`relative z-10 ${fontSize} font-bold text-muted-foreground`}>
                    {initial}
                </span>
            )}
        </div>
    )
}

function SearchableDropdown({
    accounts,
    selectedId,
    onSelect,
    allLabel,
    searchPlaceholder,
    buttonClassName,
    dropdownMinWidth,
    emptyLabel,
    ariaLabel,
}: {
    accounts: Account[]
    selectedId: string
    onSelect: (id: string) => void
    allLabel?: string
    searchPlaceholder?: string
    buttonClassName?: string
    dropdownMinWidth?: number
    emptyLabel?: string
    ariaLabel?: string
}) {
    const [open, setOpen] = useState(false)
    const [search, setSearch] = useState('')
    const searchRef = useRef<HTMLInputElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const dropdownRef = useRef<HTMLDivElement>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const dropdownId = useId()
    const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null)
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const privacyLevelEmail = useUIStore(s => s.privacyLevelEmail)
    const privacyLevel = isPrivacyModeEnabled ? privacyLevelNames : 0
    const emailPrivacy = isPrivacyModeEnabled ? privacyLevelEmail : 0

    const closeDropdown = () => {
        setOpen(false)
        buttonRef.current?.focus()
    }

    const handleDropdownKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault()
            closeDropdown()
            return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const options = Array.from(dropdownRef.current?.querySelectorAll<HTMLButtonElement>('[data-account-option]') ?? [])
        const current = options.indexOf(event.target as HTMLButtonElement)
        if (!options.length || (current < 0 && !['ArrowDown', 'ArrowUp'].includes(event.key))) return
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
            : current < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
        options[next]?.focus()
    }

    useEffect(() => {
        if (open) {
            setSearch('')
            setTimeout(() => searchRef.current?.focus(), 0)
            const updatePos = () => {
                if (buttonRef.current) {
                    const pill = buttonRef.current.closest('[data-account-switcher-pill]') as HTMLElement | null
                    const refEl = pill || buttonRef.current
                    const rect = refEl.getBoundingClientRect()
                    const width = Math.min(Math.max(rect.width, dropdownMinWidth || 0), window.innerWidth - 16)
                    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
                    setDropdownPos({ top: rect.bottom + 4, left, width })
                }
            }
            updatePos()
            window.addEventListener('resize', updatePos)
            window.addEventListener('scroll', updatePos, true)
            return () => {
                window.removeEventListener('resize', updatePos)
                window.removeEventListener('scroll', updatePos, true)
            }
        } else {
            setDropdownPos(null)
        }
    }, [open, dropdownMinWidth])

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (
                containerRef.current && !containerRef.current.contains(e.target as Node) &&
                (!dropdownRef.current || !dropdownRef.current.contains(e.target as Node))
            ) {
                setOpen(false)
            }
        }
        if (open) document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    const filtered = useMemo(() => {
        if (!search.trim()) return accounts
        const q = normalizeForSearch(search)
        return accounts.filter(a =>
            normalizeForSearch(a.name || '').includes(q) ||
            normalizeForSearch(a.email || '').includes(q)
        )
    }, [accounts, search])

    const selectedAccount = accounts.find(a => a.id === selectedId)

    const dropdown = open && dropdownPos ? createPortal(
        <div
            ref={dropdownRef}
            id={dropdownId}
            role="dialog"
            aria-label={ariaLabel ? `${ariaLabel} options` : 'Choose an account'}
            data-theme-part="popover"
            onKeyDown={handleDropdownKeyDown}
            style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width, zIndex: 40 }}
            className="bg-card border border-border/40 rounded-2xl shadow-lg overflow-hidden"
        >
            <div className="p-2 border-b border-border/40">
                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <input
                        ref={searchRef}
                        data-theme-part="input"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder={searchPlaceholder || 'Search accounts...'}
                        aria-label={searchPlaceholder || 'Search accounts'}
                        className="w-full h-8 pl-8 pr-3 text-xs bg-muted/30 border border-border/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/30"
                    />
                </div>
            </div>
            <div className="max-h-60 overflow-y-auto p-1">
                {allLabel && (
                    <button
                        data-account-option
                        data-theme-part="menu-item"
                        aria-current={selectedId === 'all' ? 'true' : undefined}
                        onClick={() => { onSelect('all'); closeDropdown() }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-xs rounded-lg transition-colors ${selectedId === 'all' ? 'bg-primary/12 text-primary border border-primary/25' : 'hover:bg-muted/50'}`}
                    >
                        {allLabel}
                    </button>
                )}
                {filtered.length === 0 && (
                    <div className="px-3 py-4 text-xs text-muted-foreground text-center">No accounts found</div>
                )}
                {filtered.map(acc => (
                    <button
                        key={acc.id}
                        data-account-option
                        data-theme-part="menu-item"
                        aria-current={acc.id === selectedId ? 'true' : undefined}
                        onClick={() => { onSelect(acc.id); closeDropdown() }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-xs rounded-lg transition-colors ${acc.id === selectedId ? 'bg-primary/12 text-primary border border-primary/25' : 'hover:bg-muted/50'}`}
                    >
                        <AccountAvatar account={acc} size="sm" />
                        <span className="truncate">{maskedDisplayName(acc.name, acc.email, privacyLevel, emailPrivacy) || 'Unknown Account'}</span>
                    </button>
                ))}
            </div>
        </div>,
        document.body
    ) : null

    return (
        <div ref={containerRef}>
            <button
                ref={buttonRef}
                type="button"
                data-theme-part="button"
                aria-label={ariaLabel}
                aria-expanded={open}
                aria-haspopup="dialog"
                aria-controls={open ? dropdownId : undefined}
                onClick={() => setOpen(!open)}
                className={buttonClassName || OUTLINE_BTN}
            >
                {selectedAccount ? (
                    <>
                        <AccountAvatar account={selectedAccount} size="sm" />
                        <span className="flex-1 text-left truncate">{maskedDisplayName(selectedAccount.name, selectedAccount.email, privacyLevel, emailPrivacy)}</span>
                    </>
                ) : allLabel ? (
                    <span className="flex-1 text-left truncate">{allLabel}</span>
                ) : (
                    <span className="flex-1 text-left truncate">{emptyLabel || 'Select'}</span>
                )}
                <ChevronDown className="h-4 w-4 opacity-50 ml-auto shrink-0" />
            </button>
            {dropdown}
        </div>
    )
}

export function AccountSwitcher(props: AccountSwitcherProps) {
    if (props.mode === 'filter') {
        const { accounts, selectedId, onSelect, allLabel, placeholder, buttonClassName, emptyLabel, ariaLabel } = props
        return (
            <SearchableDropdown
                accounts={accounts}
                selectedId={selectedId}
                onSelect={onSelect}
                allLabel={allLabel}
                searchPlaceholder={placeholder}
                buttonClassName={buttonClassName}
                dropdownMinWidth={220}
                emptyLabel={emptyLabel}
                ariaLabel={ariaLabel}
            />
        )
    }

    const { accounts, selectedId, onSelect, onPrev, onNext, prevLabel, nextLabel } = props
    const currentIndex = accounts.findIndex(a => a.id === selectedId)

    return (
        <div className="inline-flex items-center gap-1.5">
            <div className="[&>div]:contents">
                <SearchableDropdown
                    accounts={accounts}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    buttonClassName={OUTLINE_BTN + " gap-1.5 w-auto"}
                />
            </div>
            <Tooltip content={prevLabel || 'Previous account'} side="bottom">
                <button type="button" data-theme-part="button" className={OUTLINE_BTN + " px-2"} onClick={onPrev} aria-label="Previous account">
                    <ChevronLeft className="h-4 w-4" />
                </button>
            </Tooltip>
            <span data-theme-part="button" className={OUTLINE_BTN + " px-2 tabular-nums select-none pointer-events-none"}>
                {currentIndex >= 0 ? currentIndex + 1 : '-'}/{accounts.length}
            </span>
            <Tooltip content={nextLabel || 'Next account'} side="bottom">
                <button type="button" data-theme-part="button" className={OUTLINE_BTN + " px-2"} onClick={onNext} aria-label="Next account">
                    <ChevronRight className="h-4 w-4" />
                </button>
            </Tooltip>
        </div>
    )
}
