import { memo } from 'react'
import { useUIStore } from '@/store/uiStore'
import { maskedInitial } from '@/lib/utils'
import type { RailWatcher } from '@/components/ui/content-rail'

export const WatcherBadges = memo(function WatcherBadges({ watchers }: { watchers: RailWatcher[] }) {
    const privacyLevel = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelNames : 0))
    if (!watchers || watchers.length === 0) return null
    return (
        <div className="absolute bottom-2 right-2 z-10 flex items-center -space-x-1.5">
            {watchers.slice(0, 3).map(w => (
                <div key={w.id} className="h-5 w-5 rounded-full border border-background overflow-hidden bg-card shadow-sm flex items-center justify-center">
                    {w.avatar ? (
                        <img src={w.avatar} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : w.emoji ? (
                        <span className="text-[9px]">{w.emoji}</span>
                    ) : (
                        <span className="text-[8px] font-bold text-muted-foreground">{maskedInitial(w.name, privacyLevel) || '?'}</span>
                    )}
                </div>
            ))}
            {watchers.length > 3 && (
                <div className="h-5 w-5 rounded-full border border-background bg-card shadow-sm flex items-center justify-center">
                    <span className="text-[8px] font-bold text-muted-foreground">+{watchers.length - 3}</span>
                </div>
            )}
        </div>
    )
})
