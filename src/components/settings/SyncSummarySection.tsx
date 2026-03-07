import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Link2, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react'
import { useAddonStore } from '@/store/addonStore'

export function SyncSummarySection() {
    const { library, accountStates } = useAddonStore()
    const [isExpanded, setIsExpanded] = useState(false)
    const navigate = useNavigate()

    // Find all addons in the library that have syncWithInstalled enabled
    const syncedAddons = Object.values(library).filter(a => a.syncWithInstalled)

    if (syncedAddons.length === 0) return null

    const displayCount = isExpanded ? syncedAddons.length : 3
    const hasMore = syncedAddons.length > 3

    return (
        <section className="space-y-4">
            <div className="p-4 rounded-xl border bg-card/50 space-y-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-lg bg-primary/10">
                            <Link2 className="h-4 w-4 text-primary" />
                        </div>
                        <div className="flex items-center gap-2">
                            <h3 className="text-sm font-semibold">Active Sync Connections</h3>
                            <span className="bg-primary/10 text-primary text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-tighter">
                                {syncedAddons.length}
                            </span>
                        </div>
                    </div>
                    <button
                        className="text-[10px] font-bold text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 uppercase tracking-widest"
                        onClick={() => navigate('/saved-addons')}
                    >
                        Manage
                        <ChevronRight className="h-3 w-3" />
                    </button>
                </div>

                <div className="space-y-2">
                    {syncedAddons.slice(0, displayCount).map((addon, idx) => (
                        <div key={idx} className="flex items-center justify-between p-2 rounded-lg bg-background/30 border border-border/30">
                            <div className="flex items-center gap-3 overflow-hidden">
                                <div className="w-6 h-6 rounded bg-muted/50 flex-shrink-0 overflow-hidden border border-border/30">
                                    {(addon.metadata?.customLogo || addon.manifest.logo) && (
                                        <img
                                            src={addon.metadata?.customLogo || addon.manifest.logo}
                                            alt=""
                                            className="w-full h-full object-contain"
                                            onError={(e) => { e.currentTarget.style.display = 'none' }}
                                        />
                                    )}
                                </div>
                                <span className="text-xs font-bold truncate">{addon.name}</span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0 text-right">
                                <span className="text-[10px] text-muted-foreground italic">
                                    {(() => {
                                        let count = 0
                                        for (const accState of Object.values(accountStates)) {
                                            if (accState.installedAddons.some(ia => ia.installUrl === addon.installUrl)) count++
                                        }
                                        return count > 0 ? `${count} account${count !== 1 ? 's' : ''}` : 'Not installed'
                                    })()}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>

                {hasMore && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="w-full h-8 text-[11px] font-bold text-muted-foreground hover:text-primary"
                        onClick={() => setIsExpanded(!isExpanded)}
                    >
                        {isExpanded ? (
                            <>
                                <ChevronUp className="mr-2 h-3 w-3" />
                                SHOW LESS
                            </>
                        ) : (
                            <>
                                <ChevronDown className="mr-2 h-3 w-3" />
                                SHOW ALL ({syncedAddons.length})
                            </>
                        )}
                    </Button>
                )}
            </div>
        </section>
    )
}
