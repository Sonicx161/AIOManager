import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUpRight, Bell } from 'lucide-react'
import { SquircleOverlay } from '@/components/ui/squircle-overlay'
import { AccountSwitcher } from '@/components/common/AccountSwitcher'
import { getAccountEmail, useAccountStore } from '@/store/accountStore'
import { SettingsGroup, SettingsGroupFooter, SettingsRow, SettingsRowSeparator } from '@/components/settings/SettingsRows'

export function NotificationsSection() {
    const accounts = useAccountStore(state => state.accounts)
    const [accountId, setAccountId] = useState('')
    const navigate = useNavigate()
    const selectedAccount = accounts.length === 1 ? accounts[0] : accounts.find(account => account.id === accountId)

    const pickerAccounts = useMemo(() => accounts.map(account => ({
        id: account.id,
        name: account.name || '',
        email: getAccountEmail(account) || undefined,
        emoji: account.emoji,
        avatar: account.avatar,
    })), [accounts])

    return (
        <section className="space-y-3">
            <div className="flex items-center gap-3">
                <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-border/35 bg-muted/25 sm:h-10 sm:w-10">
                    <SquircleOverlay />
                    <Bell className="relative z-10 h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                    <h2 className="text-base font-bold">Monitoring &amp; Alerts</h2>
                    <p className="text-sm text-muted-foreground">Webhook notifications are configured per Autopilot rule.</p>
                </div>
            </div>

            <SettingsGroup>
                <SettingsRow
                    icon={Bell}
                    label="Webhooks"
                    trailing={accounts.length === 0
                        ? <span className="shrink-0 text-sm text-muted-foreground">Add an account</span>
                        : (
                            <AccountSwitcher
                                mode="filter"
                                accounts={pickerAccounts}
                                selectedId={selectedAccount?.id ?? ''}
                                onSelect={setAccountId}
                                emptyLabel="Choose an account"
                                ariaLabel="Autopilot webhooks account"
                                // Capped so a long account name truncates instead of the row label.
                                buttonClassName="inline-flex h-8 max-w-[11rem] items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-border/40 bg-muted/30 px-3 text-xs font-medium shadow-sm transition-colors hover:bg-muted/50 hover:text-foreground sm:max-w-[14rem]"
                            />
                        )}
                />
                <SettingsRowSeparator />
                <SettingsRow
                    label="Open Autopilot"
                    disabled={!selectedAccount}
                    onClick={() => {
                        if (selectedAccount) navigate('/account/' + encodeURIComponent(selectedAccount.id) + '?tab=failover')
                    }}
                    trailing={<ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />}
                />
                <SettingsGroupFooter>
                    Set an account's default webhook or a notification for a specific rule.
                    {accounts.length === 0 && ' Add an account to configure notifications.'}
                </SettingsGroupFooter>
            </SettingsGroup>
        </section>
    )
}
