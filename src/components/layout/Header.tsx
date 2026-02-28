import { Link, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useTheme } from '@/contexts/ThemeContext'
import { useSyncStore } from '@/store/syncStore'
import { useFailoverStore } from '@/store/failoverStore'
import { LogOut, LayoutDashboard, Package, Activity, BarChart3, Settings, HelpCircle, Zap, ZapOff, ShieldCheck, ExternalLink } from 'lucide-react'
import { SyncStatus } from '@/components/SyncStatus'
import { useVaultStore } from '@/store/vaultStore'
import { useProviderStore } from '@/store/providerStore'
import { PROVIDERS } from '@/lib/constants'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function Header() {
  const location = useLocation()
  const { theme } = useTheme()
  const isInverted = theme === 'light' || theme === 'hoth'
  const { auth, logout } = useSyncStore()
  const { rules, lastWorkerRun } = useFailoverStore()

  const { keys } = useVaultStore()
  const { health } = useProviderStore()

  const activeRulesCount = rules.filter(r => r.isActive).length
  const hasRules = rules.length > 0
  const isServerLive = lastWorkerRun && (Date.now() - new Date(lastWorkerRun).getTime()) < 90000

  const autopilotStatus = !isServerLive ? 'Offline' :
    !hasRules ? 'Standby' :
      activeRulesCount > 0 ? 'Live' : 'Paused'

  const statusColor = autopilotStatus === 'Live' ? 'text-amber-500 border-amber-500/20 bg-amber-500/10' :
    autopilotStatus === 'Paused' ? 'text-amber-500/60 border-amber-500/10 bg-amber-500/5' :
      autopilotStatus === 'Standby' ? 'text-blue-500/60 border-blue-500/10 bg-blue-500/5' :
        'text-muted-foreground opacity-60 border-muted-foreground/10 bg-muted/30'

  const providerKeys = keys
    .filter(k => ['real-debrid', 'torbox', 'premiumize', 'alldebrid'].includes(k.provider))

  const getProviderAbbr = (provider: string) => {
    switch (provider) {
      case 'real-debrid': return 'RD'
      case 'torbox': return 'TB'
      case 'premiumize': return 'PM'
      case 'alldebrid': return 'AD'
      default: return provider.substring(0, 2).toUpperCase()
    }
  }

  const getStatusRingColor = (h: any) => {
    if (!h) return 'border-muted-foreground/20 opacity-40'
    if (h.loading) return 'border-blue-500 animate-pulse ring-2 ring-blue-500/20'
    if (h.status === 'active') return 'border-green-500/60 ring-1 ring-green-500/10 shadow-[0_0_8px_rgba(34,197,94,0.1)]'
    if (h.status === 'expired') return 'border-amber-500/60 ring-1 ring-amber-500/10 shadow-[0_0_8px_rgba(245,158,11,0.1)]'
    if (h.status === 'error') return 'border-destructive/60 ring-1 ring-destructive/10'
    return 'border-muted-foreground/20 opacity-60'
  }

  return (
    <header className="border-b bg-card/95 sticky top-0 z-40">
      <div className="container mx-auto px-4 py-4 md:py-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center justify-between w-full md:w-auto">
            <Link to="/" className="flex items-center gap-2 md:gap-3 hover:opacity-90 transition-opacity shrink-0">
              <img
                src="/logo.png"
                alt="AIOManager Logo"
                className={`h-8 w-8 md:h-12 md:w-12 object-contain transition-all ${isInverted ? 'invert' : ''}`}
              />
              <div>
                <h1 className="text-lg md:text-2xl font-bold tracking-tight">
                  AIOManager
                </h1>
                <p className="hidden xl:block text-sm text-muted-foreground">
                  Manage multiple Stremio accounts, addons and more
                </p>
              </div>
            </Link>

            {/* Mobile Logout (Shows next to logo on tiny screens) */}
            {auth.isAuthenticated && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  logout();
                }}
                className="md:hidden text-muted-foreground hover:text-destructive transition-colors p-2 rounded-md hover:bg-muted"
                title="Logout"
              >
                <LogOut className="h-5 w-5" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Provider Health Badges */}
            {providerKeys.length > 0 && (
              <>
                {/* Desktop: Full Badges */}
                <div className="hidden xl:flex items-center gap-1.5 px-2 py-1 rounded-full border bg-card/30 shadow-sm border-white/5">
                  {providerKeys.map((key) => {
                    const h = health[key.id]
                    return (
                      <DropdownMenu key={key.id}>
                        <DropdownMenuTrigger asChild>
                          <div className="flex items-center justify-center p-0.5 rounded-full hover:bg-white/5 transition-colors cursor-pointer">
                            <button className={`relative flex items-center justify-center w-8 h-8 rounded-full bg-background/50 border-2 transition-all group overflow-hidden ${getStatusRingColor(h)} hover:scale-110 active:scale-90`}>
                              <span className="text-[10px] font-black tracking-tight text-muted-foreground group-hover:text-foreground">
                                {getProviderAbbr(key.provider)}
                              </span>
                            </button>
                          </div>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56 p-3 space-y-2 mt-2 z-50">
                          <div className="flex items-center gap-2 mb-1">
                            <ShieldCheck className="h-4 w-4 text-primary" />
                            <span className="font-bold text-sm">
                              {key.name}
                            </span>
                          </div>
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="text-muted-foreground">Status</span>
                              <span className={`font-bold uppercase ${h?.status === 'active' ? 'text-green-500' : h?.status === 'expired' ? 'text-amber-500' : 'text-destructive'}`}>
                                {h?.status || 'UNKNOWN'}
                              </span>
                            </div>
                            {h?.error && (
                              <p className="text-[10px] text-destructive leading-tight italic">
                                {h.error}
                              </p>
                            )}
                            {h?.daysRemaining !== null && h?.daysRemaining !== undefined && (() => {
                              const total = h.daysRemaining
                              const years = Math.floor(total / 365)
                              const months = Math.floor((total % 365) / 30)
                              const days = total % 30
                              const parts = []
                              if (years > 0) parts.push(`${years}y`)
                              if (months > 0) parts.push(`${months}mo`)
                              if (days > 0 || parts.length === 0) parts.push(`${days}d`)
                              return (
                                <>
                                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                    <span>Remaining</span>
                                    <span className="font-medium text-foreground">{parts.join(' ')}</span>
                                  </div>
                                  {h?.expiresAt && (
                                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                      <span>Expires</span>
                                      <span className="font-medium text-foreground">
                                        {new Date(h.expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                      </span>
                                    </div>
                                  )}
                                </>
                              )
                            })()}
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-white/5">
                              <span>Last Checked</span>
                              <span>{h?.lastChecked ? new Date(h.lastChecked).toLocaleTimeString() : 'Never'}</span>
                            </div>
                            {PROVIDERS.find(p => p.value === key.provider)?.url && (
                              <a
                                href={PROVIDERS.find(p => p.value === key.provider)!.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center justify-between text-[10px] text-primary hover:underline pt-1 border-t border-white/5"
                              >
                                <span>API Dashboard</span>
                                <ExternalLink className="h-2.5 w-2.5" />
                              </a>
                            )}
                          </div>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  })}
                </div>


              </>
            )}

            {/* Autopilot Status Badge */}
            <div
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full border shadow-sm transition-all cursor-help ${statusColor}`}
              title={
                !isServerLive ? 'Autopilot Server is offline or heartbeat lost' :
                  !hasRules ? 'Autopilot Live: No rules configured' :
                    activeRulesCount > 0 ? `Autopilot Monitoring: ${activeRulesCount} active rules` :
                      'Autopilot Paused: All rules are disabled'
              }
            >
              <div className="relative flex items-center justify-center">
                {autopilotStatus === 'Live' && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-[ping_2s_ease-in-out_infinite] mr-1.5" />
                )}
                {autopilotStatus === 'Live' ? (
                  <Zap className="h-3.5 w-3.5 fill-amber-500" />
                ) : (
                  <ZapOff className="h-3.5 w-3.5" />
                )}
              </div>
              <span className="text-[10px] font-bold uppercase tracking-widest whitespace-nowrap">
                Autopilot: {autopilotStatus}
              </span>
            </div>

            <SyncStatus />

            {/* Desktop User Identity & Logout */}
            {auth.isAuthenticated && (
              <div className="hidden md:flex items-center gap-2 border border-white/10 pl-1.5 pr-3 py-1 rounded-full bg-white/[0.04] hover:bg-white/[0.07] hover:border-white/[0.13] transition-all cursor-pointer">
                {/* Avatar initial */}
                <div className="w-6 h-6 rounded-full bg-amber-500/20 border border-amber-500/25 flex items-center justify-center text-[11px] font-bold text-amber-400 shadow-[0_0_8px_rgba(245,200,66,0.08)] flex-shrink-0">
                  {(auth.name || auth.id).charAt(0).toUpperCase()}
                </div>
                {/* Text */}
                <div className="flex flex-col leading-none gap-[2px]">
                  <span className="hidden xl:block text-[9px] text-muted-foreground/60 uppercase tracking-[0.5px] font-medium">Logged in as</span>
                  <span className="text-[12px] font-semibold text-foreground" title={auth.id}>
                    {auth.name || `${auth.id.split('-')[0]}...`}
                  </span>
                </div>
                {/* Divider + logout */}
                <div className="h-4 w-px bg-white/10 mx-0.5" />
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); logout(); }}
                  className="text-muted-foreground/50 hover:text-destructive transition-colors p-0.5"
                  title="Logout"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
        {/* Desktop Navigation Tabs */}
        <div className="hidden md:flex gap-1 mt-4 border-b overflow-x-auto scrollbar-hide whitespace-nowrap -mx-4 px-4 sm:mx-0 sm:px-0">
          <Link
            to="/"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/' || location.pathname.startsWith('/account/')
              ? 'border-primary text-foreground font-semibold [filter:drop-shadow(0_2px_6px_hsl(var(--primary)/0.4))]'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-primary/30'
              }`}
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            <span className="text-[13px]">Accounts</span>
          </Link>
          <Link
            to="/saved-addons"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/saved-addons'
              ? 'border-primary text-foreground font-semibold [filter:drop-shadow(0_2px_6px_hsl(var(--primary)/0.4))]'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-primary/30'
              }`}
          >
            <Package className="h-3.5 w-3.5" />
            <span className="text-[13px]">Addons</span>
          </Link>

          <Link
            to="/activity"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/activity'
              ? 'border-primary text-foreground font-semibold [filter:drop-shadow(0_2px_6px_hsl(var(--primary)/0.4))]'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-primary/30'
              }`}
          >
            <Activity className="h-3.5 w-3.5" />
            <span className="text-[13px]">Activity</span>
          </Link>
          <Link
            to="/metrics"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/metrics'
              ? 'border-primary text-foreground font-semibold [filter:drop-shadow(0_2px_6px_hsl(var(--primary)/0.4))]'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-primary/30'
              }`}
          >
            <BarChart3 className="h-3.5 w-3.5" />
            <span className="text-[13px]">Metrics</span>
          </Link>
          <Link
            to="/replay"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/replay'
              ? 'border-primary text-foreground font-semibold [filter:drop-shadow(0_2px_6px_hsl(var(--primary)/0.4))]'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-primary/30'
              }`}
          >
            <motion.div initial="initial" animate="animate" className="flex items-center justify-center">
              <motion.svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <motion.path d="m11 19-9-7 9-7v14z" variants={{ initial: { opacity: 0.4 }, animate: { opacity: [0.4, 1, 0.4], transition: { repeat: Infinity, duration: 1.5, ease: 'linear' } } }} />
                <motion.path d="m22 19-9-7 9-7v14z" variants={{ initial: { opacity: 1 }, animate: { opacity: [1, 0.4, 1], transition: { repeat: Infinity, duration: 1.5, ease: 'linear' } } }} />
              </motion.svg>
            </motion.div>
            <span className="text-[13px]">Replay</span>
          </Link>
          <Link
            to="/settings"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/settings'
              ? 'border-primary text-foreground font-semibold [filter:drop-shadow(0_2px_6px_hsl(var(--primary)/0.4))]'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-primary/30'
              }`}
          >
            <Settings className="h-3.5 w-3.5" />
            <span className="text-[13px]">Settings</span>
          </Link>
          <Link
            to="/faq"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/faq'
              ? 'border-primary text-foreground font-semibold [filter:drop-shadow(0_2px_6px_hsl(var(--primary)/0.4))]'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-primary/30'
              }`}
          >
            <HelpCircle className="h-3.5 w-3.5" />
            <span className="text-[13px]">FAQ</span>
          </Link>
        </div>
      </div>

      {/* Mobile Bottom Navigation Bar */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-lg border-t border-border flex items-center justify-around min-h-[76px] pb-[calc(env(safe-area-inset-bottom,0px)+8px)] shadow-[0_-10px_40px_rgba(0,0,0,0.15)]">
        {[
          { to: '/', icon: LayoutDashboard, label: 'Accounts' },
          { to: '/saved-addons', icon: Package, label: 'Addons' },
          { to: '/activity', icon: Activity, label: 'Activity' },
          { to: '/metrics', icon: BarChart3, label: 'Metrics' },
          { to: '/replay', icon: null, label: 'Replay' },
          { to: '/settings', icon: Settings, label: 'Settings' },
        ].map((item) => {
          const isActive = location.pathname === item.to || (item.to === '/' && location.pathname.startsWith('/account/'));
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={`flex flex-col items-center justify-center pt-3 pb-1 px-1 w-full transition-colors ${isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {item.to === '/replay' ? (
                <motion.div initial="initial" animate="animate" className="flex items-center justify-center mb-0.5">
                  <motion.svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <motion.path d="m11 19-9-7 9-7v14z" variants={{ initial: { opacity: 0.4 }, animate: { opacity: [0.4, 1, 0.4], transition: { repeat: Infinity, duration: 1.5, ease: 'linear' } } }} />
                    <motion.path d="m22 19-9-7 9-7v14z" variants={{ initial: { opacity: 1 }, animate: { opacity: [1, 0.4, 1], transition: { repeat: Infinity, duration: 1.5, ease: 'linear' } } }} />
                  </motion.svg>
                </motion.div>
              ) : (
                Icon && <Icon className="h-5 w-5 mb-0.5" />
              )}
              <span className="text-[10px] font-black uppercase tracking-tighter opacity-80">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </header>
  )
}
