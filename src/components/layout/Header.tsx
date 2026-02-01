import { Link, useLocation } from 'react-router-dom'
import { useTheme } from '@/contexts/ThemeContext'
import { useSyncStore } from '@/store/syncStore'
import { LogOut } from 'lucide-react'
import { SyncStatus } from '@/components/SyncStatus'

export function Header() {
  const location = useLocation()
  const { theme } = useTheme()
  const isInverted = theme === 'light' || theme === 'hoth'
  const { auth, logout } = useSyncStore()

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

          <div className="flex items-center gap-4">
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
        <div className="flex gap-4 mt-4 border-b">
          <Link
            to="/"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 ${location.pathname === '/' || location.pathname.startsWith('/account/')
              ? 'border-primary text-foreground font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
          >
            Accounts
          </Link>
          <Link
            to="/saved-addons"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 ${location.pathname === '/saved-addons'
              ? 'border-primary text-foreground font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
          >
            Saved Addons
          </Link>

          <Link
            to="/activity"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 ${location.pathname === '/activity'
              ? 'border-primary text-foreground font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
          >
            Activity
          </Link>
          <Link
            to="/metrics"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 ${location.pathname === '/metrics'
              ? 'border-primary text-foreground font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
          >
            Metrics
          </Link>
          <Link
            to="/settings"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 ${location.pathname === '/settings'
              ? 'border-primary text-foreground font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
          >
            Settings
          </Link>
          <Link
            to="/faq"
            className={`pb-2 px-3 border-b-2 transition-colors duration-150 ${location.pathname === '/faq'
              ? 'border-primary text-foreground font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
          >
            Features & FAQ
          </Link>
        </div>
      </div>
    </header>
  )
}
