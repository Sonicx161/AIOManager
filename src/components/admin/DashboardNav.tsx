/**
 * The dashboard pills that replace the app's main nav while on /dashboard.
 * Same position and pill style as the app nav, with a leading "Back to app" so
 * the user can leave. Pills that do not fit move into the shared More pill, and
 * the current section always stays visible. Deliberately free of API imports:
 * this module loads with the entry chunk via Header.
 */
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PriorityPillNav } from '@/components/ui/priority-nav'
import { dashboardNavItems } from './sections'

const ITEMS = dashboardNavItems()

export function DashboardNav({ isLight }: { isLight: boolean }) {
  const location = useLocation()
  const navigate = useNavigate()

  const pillClass = (isActive: boolean) => cn(
    'relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium transition-[transform,opacity,box-shadow]',
    isActive
      ? (isLight
        ? 'border border-border/40 bg-background text-foreground shadow-sm'
        : 'border border-white/10 bg-white/[0.08] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]')
      : (isLight
        ? 'text-muted-foreground hover:bg-background/45 hover:text-foreground'
        : 'text-muted-foreground hover:bg-white/[0.055] hover:text-foreground'),
  )

  return (
    <PriorityPillNav
      items={ITEMS}
      activePath={location.pathname}
      className={cn(
        'pointer-events-auto inline-flex h-auto items-center justify-start gap-1.5 rounded-2xl border border-border/40 bg-card/92 p-1.5 text-muted-foreground shadow-sm backdrop-blur-xl',
        !isLight && 'border-white/10 bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
      )}
      triggerClassName={(open) => cn(
        'relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-[13px] font-medium transition-[transform,opacity,box-shadow]',
        open
          ? (isLight
            ? 'border-border/40 bg-background text-foreground shadow-sm'
            : 'border-white/10 bg-white/[0.08] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]')
          : (isLight
            ? 'border-transparent text-muted-foreground hover:bg-background/45 hover:text-foreground'
            : 'border-transparent text-muted-foreground hover:bg-white/[0.055] hover:text-foreground'),
      )}
      onNavigate={(item) => navigate(item.to)}
      menuItemClassName="gap-2 pr-2"
      menuContentClassName="min-w-[13rem]"
      renderItem={(item, active) => {
        const Icon = item.icon
        return (
          <Link
            data-theme-part="nav-item"
            data-state={active ? 'active' : 'inactive'}
            aria-current={active ? 'page' : undefined}
            aria-label={item.id === 'back' ? 'Back to the app' : undefined}
            to={item.to}
            className={pillClass(active)}
          >
            <Icon className="h-[15px] w-[15px]" strokeWidth={active ? 2.2 : 1.7} aria-hidden />
            <span>{item.label}</span>
          </Link>
        )
      }}
      renderMenuItem={(item, active) => {
        const Icon = item.icon
        return (
          <>
            <span className="flex h-4 w-4 items-center justify-center">
              <Icon className="h-[15px] w-[15px]" strokeWidth={1.7} aria-hidden />
            </span>
            <span className={active ? 'font-semibold' : undefined}>{item.label}</span>
            {active && <Check className="ml-auto h-3.5 w-3.5" strokeWidth={2.2} />}
          </>
        )
      }}
    />
  )
}
