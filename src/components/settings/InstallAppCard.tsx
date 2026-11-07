import { useEffect, useState } from 'react'
import { MonitorDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { canInstall, subscribeInstall, promptInstall } from '@/lib/pwa'
import { SettingsGroup, SettingsGroupFooter, SettingsRow } from '@/components/settings/SettingsRows'

export function InstallAppCard() {
    const [installable, setInstallable] = useState(canInstall())

    useEffect(() => subscribeInstall(setInstallable), [])

    if (!installable) return null

    return (
        <SettingsGroup>
            <SettingsRow
                icon={MonitorDown}
                label="Install App"
                trailing={
                    <Button variant="outline" onClick={() => { promptInstall() }} className="h-8 shrink-0 gap-2 px-3 text-xs">
                        <MonitorDown className="h-4 w-4" />
                        Install
                    </Button>
                }
            />
            <SettingsGroupFooter>
                Add AIOManager to your device for an app-like window
            </SettingsGroupFooter>
        </SettingsGroup>
    )
}
