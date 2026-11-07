import { useState, useEffect, useRef } from 'react'
import { ChevronDown, Search, Check, Users } from 'lucide-react'
import { Account } from '@/types/account'
import { accountMatchesQuery, getAccountEmail } from '@/lib/account-compat'
import { ACCOUNT_COLORS, maskEmailLevel } from '@/lib/utils'
import { useUIStore } from '@/store/uiStore'
import { maskedDisplayName } from '@/components/common/AccountSwitcher'

interface ReplayAccountSwitcherProps {
    accounts: Account[]
    selectedAccountId: string
    onSelect: (id: string) => void
}

export function ReplayAccountSwitcher({ accounts, selectedAccountId, onSelect }: ReplayAccountSwitcherProps) {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const containerRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const namePrivacy = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelNames : 0))
    const emailPrivacy = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelEmail : 0))
    const displayName = (acc: Account) => maskedDisplayName(acc.name, getAccountEmail(acc), namePrivacy, emailPrivacy)

    useEffect(() => {
        if (!open) return
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false)
                setQuery('')
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 50)
    }, [open])

    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setQuery('') } }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [])

    const filtered = accounts.filter(a => accountMatchesQuery(a, query))

    const triggerLabel = selectedAccountId === 'all'
        ? 'All Accounts'
        : (() => {
            const acc = accounts.find(a => a.id === selectedAccountId)
            return acc ? displayName(acc) : 'All Accounts'
        })()

    const triggerColor = selectedAccountId === 'all'
        ? null
        : ACCOUNT_COLORS[accounts.findIndex(a => a.id === selectedAccountId) % ACCOUNT_COLORS.length]

    const getInitials = (name: string) =>
        name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2)

    return (
        <div ref={containerRef} className="relative shrink-0 pointer-events-auto">

            <button
                type="button"
                aria-expanded={open}
                data-theme-part="select-trigger"
                onClick={() => setOpen(v => !v)}
                style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 14px 8px 10px',
                    background: open ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.06)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    boxShadow: open
                        ? '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12)'
                        : '0 4px 16px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)',
                    borderRadius: 999,
                    cursor: 'pointer',
                    transition: 'all 200ms ease',
                    maxWidth: 240,
                }}
            >
                {triggerColor ? (
                    <div style={{
                        width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                        background: triggerColor,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 9, fontWeight: 700, color: 'white',
                        fontFamily: '"DM Mono", monospace',
                    }}>
                        {getInitials(triggerLabel)}
                    </div>
                ) : (
                    <div style={{
                        width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                        background: 'rgba(255,255,255,0.1)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        <Users style={{ width: 12, height: 12, color: 'rgba(255,255,255,0.6)' }} />
                    </div>
                )}

                <span style={{
                    fontFamily: 'Inter, sans-serif',
                    fontSize: 12, fontWeight: 700,
                    color: 'rgba(255,255,255,0.85)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    maxWidth: 160,
                    display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                    {(() => {
                        const acc = accounts.find(a => a.id === selectedAccountId);
                        return (
                            <>
                                {acc?.emoji && <span style={{ flexShrink: 0 }}>{acc.emoji}</span>}
                                <span>{triggerLabel}</span>
                            </>
                        )
                    })()}
                </span>

                {selectedAccountId === 'all' && accounts.length > 1 && (
                    <span style={{
                        fontFamily: '"DM Mono", monospace',
                        fontSize: 9, fontWeight: 700,
                        color: 'rgba(255,255,255,0.35)',
                        background: 'rgba(255,255,255,0.08)',
                        borderRadius: 999, padding: '2px 7px',
                        flexShrink: 0,
                    }}>
                        {accounts.length}
                    </span>
                )}

                <ChevronDown style={{
                    width: 14, height: 14, flexShrink: 0,
                    color: 'rgba(255,255,255,0.4)',
                    transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 200ms ease',
                }} />
            </button>

            {open && (
                <div data-theme-part="popover" style={{
                    position: 'absolute',
                    top: 'calc(100% + 8px)',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: 280,
                    background: 'rgba(12,12,22,0.97)',
                    backdropFilter: 'blur(40px)',
                    WebkitBackdropFilter: 'blur(40px)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    boxShadow: '0 24px 64px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.08)',
                    borderRadius: 20,
                    overflow: 'hidden',
                    zIndex: 200,
                    animation: 'dropdownFadeIn 150ms cubic-bezier(0.34, 1.56, 0.64, 1)',
                }}>

                    <div style={{
                        padding: '12px 12px 8px',
                        borderBottom: '1px solid rgba(255,255,255,0.06)',
                    }}>
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            background: 'rgba(255,255,255,0.06)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: 12, padding: '8px 12px',
                        }}>
                            <Search style={{ width: 13, height: 13, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }} />
                            <input
                                ref={inputRef}
                                data-theme-part="input"
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="Search accounts..."
                                style={{
                                    background: 'transparent', border: 'none', outline: 'none',
                                    color: 'white', fontSize: 16, fontFamily: 'Inter, sans-serif',
                                    fontWeight: 500, width: '100%',
                                }}
                            />
                            {query && (
                                <button type="button" aria-label="Clear search" data-theme-part="button" onClick={() => setQuery('')} style={{
                                    background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%',
                                    width: 16, height: 16, cursor: 'pointer', color: 'rgba(255,255,255,0.5)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontSize: 10, flexShrink: 0,
                                }}>✕</button>
                            )}
                        </div>
                    </div>

                    <div style={{ maxHeight: 320, overflowY: 'auto', padding: '6px' }} className="no-scrollbar">

                        {!query && (
                            <button
                                type="button"
                                aria-pressed={selectedAccountId === 'all'}
                                data-theme-part="menu-item"
                                onClick={() => { onSelect('all'); setOpen(false); setQuery('') }}
                                style={{
                                    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                                    padding: '9px 10px', borderRadius: 12, border: 'none', cursor: 'pointer',
                                    background: selectedAccountId === 'all'
                                        ? 'rgba(255,255,255,0.1)'
                                        : 'transparent',
                                    transition: 'background 150ms ease',
                                    marginBottom: 2,
                                }}
                                onMouseEnter={e => { if (selectedAccountId !== 'all') (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)' }}
                                onMouseLeave={e => { if (selectedAccountId !== 'all') (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                            >
                                <div style={{
                                    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                                    background: 'rgba(255,255,255,0.08)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    border: '1px solid rgba(255,255,255,0.1)',
                                }}>
                                    <Users style={{ width: 13, height: 13, color: 'rgba(255,255,255,0.5)' }} />
                                </div>
                                <div style={{ flex: 1, textAlign: 'left' }}>
                                    <div style={{
                                        fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 700,
                                        color: 'white',
                                    }}>All Accounts</div>
                                    <div style={{
                                        fontFamily: '"DM Mono", monospace', fontSize: 9, fontWeight: 600,
                                        color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em', marginTop: 1,
                                    }}>{accounts.length} ACCOUNTS • COMBINED DATA</div>
                                </div>
                                {selectedAccountId === 'all' && (
                                    <Check style={{ width: 13, height: 13, color: '#a5b4fc', flexShrink: 0 }} />
                                )}
                            </button>
                        )}

                        {!query && (
                            <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '4px 0 6px' }} />
                        )}

                        {filtered.length === 0 ? (
                            <div style={{
                                padding: '24px 12px', textAlign: 'center',
                                fontFamily: '"DM Mono", monospace', fontSize: 11,
                                color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em',
                            }}>NO ACCOUNTS FOUND</div>
                        ) : (
                            filtered.map((acc) => {
                                const colorIndex = accounts.indexOf(acc) % ACCOUNT_COLORS.length
                                const color = ACCOUNT_COLORS[colorIndex]
                                const isSelected = selectedAccountId === acc.id
                                const name = displayName(acc)
                                const initials = getInitials(name)
                                const email = maskEmailLevel(getAccountEmail(acc) || '', emailPrivacy)

                                return (
                                    <button
                                        key={acc.id}
                                        type="button"
                                        aria-pressed={isSelected}
                                        data-theme-part="menu-item"
                                        onClick={() => { onSelect(acc.id); setOpen(false); setQuery('') }}
                                        style={{
                                            width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                                            padding: '8px 10px', borderRadius: 12, border: 'none', cursor: 'pointer',
                                            background: isSelected ? color : 'transparent',
                                            transition: 'background 150ms ease',
                                            marginBottom: 2,
                                        }}
                                        onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)' }}
                                        onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                                    >
                                        <div style={{
                                            width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                                            background: acc.avatar ? 'transparent' : color,
                                            border: `1px solid rgba(255,255,255,0.1)`,
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontFamily: '"DM Mono", monospace',
                                            fontSize: 9, fontWeight: 700, color: 'white',
                                            overflow: 'hidden',
                                        }}>
                                            {acc.avatar ? (
                                                <img src={acc.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                            ) : acc.emoji ? (
                                                <span style={{ fontSize: 13 }}>{acc.emoji}</span>
                                            ) : (
                                                initials
                                            )}
                                        </div>

                                        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                                            <div style={{
                                                fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 700,
                                                color: isSelected ? 'white' : 'rgba(255,255,255,0.8)',
                                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                                display: 'flex', alignItems: 'center', gap: '6px'
                                            }}>
                                                {acc.emoji && <span style={{ flexShrink: 0 }}>{acc.emoji}</span>}
                                                <span>{name}</span>
                                            </div>
                                            {email && email !== name && (
                                                <div style={{
                                                    fontFamily: '"DM Mono", monospace', fontSize: 9, fontWeight: 500,
                                                    color: 'rgba(255,255,255,0.25)', letterSpacing: '0.05em',
                                                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                                    marginTop: 1,
                                                }}>{email}</div>
                                            )}
                                        </div>

                                        {isSelected && (
                                            <Check style={{ width: 13, height: 13, color: 'white', flexShrink: 0 }} />
                                        )}
                                    </button>
                                )
                            })
                        )}
                    </div>

                    {accounts.length > 8 && !query && (
                        <div style={{
                            borderTop: '1px solid rgba(255,255,255,0.06)',
                            padding: '8px 16px',
                            fontFamily: '"DM Mono", monospace', fontSize: 9,
                            color: 'rgba(255,255,255,0.2)', letterSpacing: '0.15em', textAlign: 'center',
                        }}>
                            {accounts.length} ACCOUNTS TOTAL
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
