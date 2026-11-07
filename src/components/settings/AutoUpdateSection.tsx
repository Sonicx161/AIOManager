import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { PlatformLogo } from '@/components/providers/ConnectionPrimitives'
import { useAccountStore, getAccountEmail, getStremioAuthKey } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { cn, maskNameLevel } from '@/lib/utils'
import { triggerSync } from '@/lib/sync-trigger'
import { readAutoUpdateSettings, writeAutoUpdateSettings, SYNCED_SETTINGS_EVENT } from '@/lib/synced-settings'
import { AUTO_UPDATE_INTERVALS, AUTO_UPDATE_PLATFORMS, autoUpdateIntervalLabel, autoUpdatePlatformsOf, type AutoUpdateSettings } from '@/lib/auto-update'
import { SettingsCheckRow, SettingsGroup, SettingsGroupFooter, SettingsGroupLabel, SettingsRow, SettingsRowSeparator, SettingsValueRow } from '@/components/settings/SettingsRows'

export function AutoUpdateSection() {
    const accounts = useAccountStore(s => s.accounts)
    const isPrivacyMode = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const [settings, setSettings] = useState<AutoUpdateSettings>(readAutoUpdateSettings)

    useEffect(() => {
        const handle = (event: Event) => {
            if ((event as CustomEvent<{ autoUpdate?: AutoUpdateSettings }>).detail?.autoUpdate) setSettings(readAutoUpdateSettings())
        }
        window.addEventListener(SYNCED_SETTINGS_EVENT, handle)
        return () => window.removeEventListener(SYNCED_SETTINGS_EVENT, handle)
    }, [])

    const update = (patch: Partial<AutoUpdateSettings>) => {
        setSettings(writeAutoUpdateSettings({ ...settings, ...patch }))
        triggerSync()
    }

    const togglePlatform = (id: string, on: boolean) =>
        update({ platforms: on ? [...settings.platforms, id] : settings.platforms.filter(p => p !== id) })
    const toggleAccount = (id: string, included: boolean) =>
        update({ excludedAccountIds: included ? settings.excludedAccountIds.filter(a => a !== id) : [...settings.excludedAccountIds, id] })

    const level = isPrivacyMode ? privacyLevelNames : 0

    return (
        <section className="space-y-3">
            <SettingsGroup>
                <SettingsRow
                    icon={RefreshCw}
                    label="Auto-update addons"
                    htmlFor="auto-update"
                    trailing={<Switch id="auto-update" checked={settings.enabled} onCheckedChange={enabled => update({ enabled })} />}
                />
                <SettingsRowSeparator />
                <div className={cn(!settings.enabled && 'pointer-events-none opacity-50')} aria-disabled={!settings.enabled}>
                    <SettingsValueRow
                        label="Check every"
                        value={autoUpdateIntervalLabel(settings.intervalHours)}
                        selected={settings.intervalHours}
                        items={AUTO_UPDATE_INTERVALS.map(hours => ({ value: hours, label: autoUpdateIntervalLabel(hours) }))}
                        onSelect={hours => update({ intervalHours: hours })}
                        disabled={!settings.enabled}
                    />
                </div>
                <SettingsGroupFooter>
                    Install newer addon versions on your accounts while the app is open. When off, updates still show on the update indicator.
                </SettingsGroupFooter>
            </SettingsGroup>

            <div className={cn(!settings.enabled && 'pointer-events-none opacity-50')} aria-disabled={!settings.enabled}>
                <SettingsGroupLabel>Platforms</SettingsGroupLabel>
                <SettingsGroup>
                    {AUTO_UPDATE_PLATFORMS.map((p, index) => (
                        <div key={p.id}>
                            {index > 0 && <SettingsRowSeparator />}
                            <SettingsCheckRow
                                leading={<PlatformLogo platform={p.id} className="h-7 w-7 rounded-lg" />}
                                label={p.label}
                                checked={settings.platforms.includes(p.id)}
                                onToggle={() => togglePlatform(p.id, !settings.platforms.includes(p.id))}
                                disabled={!settings.enabled}
                            />
                        </div>
                    ))}
                </SettingsGroup>

                {accounts.length > 0 && (
                    <>
                        <SettingsGroupLabel>Accounts</SettingsGroupLabel>
                        <SettingsGroup>
                            {accounts.map((account, index) => {
                                const updatable = autoUpdatePlatformsOf({ hasStremioAuth: !!getStremioAuthKey(account), connections: account.connections }).length > 0
                                const included = updatable && !settings.excludedAccountIds.includes(account.id)
                                return (
                                    <div key={account.id}>
                                        {index > 0 && <SettingsRowSeparator />}
                                        <SettingsCheckRow
                                            checked={included}
                                            onToggle={() => toggleAccount(account.id, included)}
                                            disabled={!settings.enabled || !updatable}
                                            note={!updatable ? 'No platform to update' : undefined}
                                            leading={<AccountAvatar account={account} size="xs" />}
                                            label={maskNameLevel(account.name || getAccountEmail(account) || 'Unnamed account', level)}
                                        />
                                    </div>
                                )
                            })}
                            <SettingsGroupFooter>
                                Apps that pull from AIOManager read addon versions from your list and fetch manifests themselves, so they need no push.
                            </SettingsGroupFooter>
                        </SettingsGroup>
                    </>
                )}
            </div>
        </section>
    )
}
