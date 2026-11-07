import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Link2, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react'
import { useAddonStore } from '@/store/addonStore'
import { SquircleOverlay } from '@/components/ui/squircle-overlay'
import { AddonIcon } from '@/components/ui/addon-icon'

export function SyncSummarySection() {
    const library = useAddonStore(s => s.library)
    const accountStates = useAddonStore(s => s.accountStates)
    const [isExpanded, setIsExpanded] = useState(false)
    const navigate = useNavigate()

    const syncedAddons = Object.values(library).filter(a => a.syncWithInstalled)

    if (syncedAddons.length === 0) return null

    const displayCount = isExpanded ? syncedAddons.length : 3
    const hasMore = syncedAddons.length > 3

    return (
        <section className="space-y-4">
            <div data-theme-part="panel" className="space-y-4 rounded-[1.75rem] border border-border/45 bg-card/80 p-5 lg:p-6 shadow-sm">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3">
                        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/35 bg-muted/25">
                            <SquircleOverlay />
                            <Link2 className="relative z-10 h-4 w-4 text-muted-foreground" />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="text-base font-semibold">Active Sync Connections</h3>
                                <span data-theme-part="badge" className="rounded-full bg-primary/12 px-1.5 py-0.5 text-xs font-bold text-primary">
                                    {syncedAddons.length}
                                </span>
                            </div>
                            <p className="text-xs text-muted-foreground">Saved addons that mirror into installed account addons.</p>
                        </div>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs font-semibold shrink-0 self-start sm:self-auto"
                        onClick={() => navigate('/saved-addons?tab=sync')}
                    >
                        <span>Manage</span>
                        <ChevronRight className="h-3 w-3" />
                    </Button>
                </div>

                <div className="grid gap-2">
                    {syncedAddons.slice(0, displayCount).map((addon, idx) => (
                        <div key={idx} data-theme-part="panel" className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl border border-border/35 bg-background/35 p-2.5">
                            <AddonIcon
                                name={addon.name}
                                logo={addon.metadata?.customLogo || addon.manifest.logo}
                                className="h-8 w-8"
                                textClassName="text-xs"
                                imageClassName="p-0.5"
                            />
                            <span className="truncate text-xs font-bold">{addon.name}</span>
                            <span data-theme-part="badge" className="shrink-0 rounded-full border border-border/30 bg-muted/25 px-2 py-1 text-xs text-muted-foreground">
                                {(() => {
                                    let count = 0
                                    for (const accState of Object.values(accountStates)) {
                                        if (accState.installedAddons.some(ia => ia.installUrl === addon.installUrl)) count++
                                    }
                                    return count > 0 ? `${count} account${count !== 1 ? 's' : ''}` : 'Not installed'
                                })()}
                            </span>
                        </div>
                    ))}
                </div>

                {hasMore && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-full gap-2 rounded-xl text-xs font-bold text-muted-foreground hover:text-primary"
                        onClick={() => setIsExpanded(!isExpanded)}
                    >
                        {isExpanded ? (
                            <>
                                <ChevronUp className="h-3 w-3" />
                                SHOW LESS
                            </>
                        ) : (
                            <>
                                <ChevronDown className="h-3 w-3" />
                                SHOW ALL ({syncedAddons.length})
                            </>
                        )}
                    </Button>
                )}
            </div>
        </section>
    )
}
