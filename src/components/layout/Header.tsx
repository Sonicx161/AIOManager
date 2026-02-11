import { Link, useLocation } from 'react-router-dom'
import { useTheme } from '@/contexts/ThemeContext'
import { useSyncStore } from '@/store/syncStore'
import { useFailoverStore } from '@/store/failoverStore'
import { LogOut, LayoutDashboard, Package, Activity, BarChart3, Settings, HelpCircle, Zap, ZapOff } from 'lucide-react'
import { SyncStatus } from '@/components/SyncStatus'

export function Header() {
  const location = useLocation()
  const { theme } = useTheme()
  const isInverted = theme === 'light' || theme === 'hoth'
  const { auth, logout } = useSyncStore()
  const { rules, lastWorkerRun } = useFailoverStore()

  const activeRulesCount = rules.filter(r => r.isActive).length
  const hasRules = rules.length > 0
  const isServerLive = lastWorkerRun && (Date.now() - new Date(lastWorkerRun).getTime()) < 120000

  // Refined Status
  const autopilotStatus = !isServerLive ? 'Offline' :
    !hasRules ? 'Standby' :
      activeRulesCount > 0 ? 'Live' : 'Paused'

  const statusColor = autopilotStatus === 'Live' ? 'text-amber-500 border-amber-500/20 bg-amber-500/10' :
    autopilotStatus === 'Paused' ? 'text-amber-500/60 border-amber-500/10 bg-amber-500/5' :
      autopilotStatus === 'Standby' ? 'text-blue-500/60 border-blue-500/10 bg-blue-500/5' :
        'text-muted-foreground opacity-60 border-muted-foreground/10 bg-muted/30'

  return (
    <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-40">
      <div className="container mx-auto px-4 py-4 md:py-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-3 hover:opacity-90 transition-opacity">
            <img
              src="/logo.png"
              alt="AIOManager Logo"
              className={`h-10 w-10 md:h-12 md:w-12 object-contain transition-all ${isInverted ? 'invert' : ''}`}
            />
            <div>
              <h1 className="text-xl md:text-2xl font-bold tracking-tight">
                AIOManager
              </h1>
              <p className="hidden sm:block text-sm text-muted-foreground">
                Manage multiple Stremio accounts, addons and more
              </p>
            </div>
          </Link>

          <div className="flex items-center gap-2">
            {/* Autopilot Status Badge */}
            <div
              className={`flex items-center gap-2 px-3 py-1 rounded-full border backdrop-blur-md shadow-sm transition-all cursor-help ${statusColor}`}
              title={
                !isServerLive ? 'Autopilot Server is offline or heartbeat lost' :
                  !hasRules ? 'Autopilot Live: No rules configured' :
                    activeRulesCount > 0 ? `Autopilot Monitoring: ${activeRulesCount} active rules` :
                      'Autopilot Paused: All rules are disabled'
              }
            >
              <div className="relative">
                {autopilotStatus === 'Live' ? (
                  <Zap className="h-3.5 w-3.5 fill-amber-500 animate-pulse" />
                ) : (
                  <ZapOff className="h-3.5 w-3.5" />
                )}
                {autopilotStatus === 'Live' && (
                  <span className="absolute -top-0.5 -right-0.5 flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500"></span>
                  </span>
                )}
              </div>
              <span className="text-[10px] font-black uppercase tracking-widest hidden md:inline whitespace-nowrap">
                Autopilot: {autopilotStatus}
              </span>
            </div>

            <SyncStatus />

            {/* User Identity & Logout */}
            {auth.isAuthenticated && (
              <div className="flex items-center gap-3 border px-3 py-1.5 rounded-full bg-background/50 backdrop-blur">
                <div className="flex flex-col items-end hidden sm:flex">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold">Logged in as</span>
                  <span className="text-xs font-mono font-medium" title={auth.id}>
                    {auth.name || `${auth.id.split('-')[0]}...`}
                  </span>
                </div>
                <div className="h-6 w-px bg-border hidden sm:block"></div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    logout();
                  }}
                  className="text-muted-foreground hover:text-destructive transition-colors p-1"
                  title="Logout"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex gap-1 mt-4 border-b overflow-x-auto scrollbar-hide whitespace-nowrap -mx-4 px-4 sm:mx-0 sm:px-0">
          <Link
            to="/"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/' || location.pathname.startsWith('/account/')
              ? 'border-primary text-foreground font-semibold'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
          >
            <LayoutDashboard className="h-4 w-4" />
            <span>Accounts</span>
          </Link>
          <Link
            to="/saved-addons"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/saved-addons'
              ? 'border-primary text-foreground font-semibold'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
          >
            <Package className="h-4 w-4" />
            <span>Saved Addons</span>
          </Link>

          <Link
            to="/activity"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/activity'
              ? 'border-primary text-foreground font-semibold'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
          >
            <Activity className="h-4 w-4" />
            <span>Activity</span>
          </Link>
          <Link
            to="/metrics"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/metrics'
              ? 'border-primary text-foreground font-semibold'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
          >
            <BarChart3 className="h-4 w-4" />
            <span>Metrics</span>
          </Link>
          <Link
            to="/settings"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/settings'
              ? 'border-primary text-foreground font-semibold'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
          >
            <Settings className="h-4 w-4" />
            <span>Settings</span>
          </Link>
          <Link
            to="/faq"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 shrink-0 flex items-center gap-2 ${location.pathname === '/faq'
              ? 'border-primary text-foreground font-semibold'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
          >
            <HelpCircle className="h-4 w-4" />
            <span>FAQ</span>
          </Link>
        </div>
      </div>
    </header>
  )
}
