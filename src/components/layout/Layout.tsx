import { ReactNode, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { Footer } from './Footer'
import { Header, MobileBottomNav } from './Header'
import { SyncIdReminder } from './SyncIdReminder'
import { ReauthBanner } from './ReauthBanner'
import { useAddonStore } from '@/store/addonStore'
import { LazyCommandPalette } from '@/components/LazyCommandPalette'

interface LayoutProps {
  children: ReactNode
}

export function Layout({ children }: LayoutProps) {
  const checkAllHealth = useAddonStore(s => s.checkAllHealth)
  const location = useLocation()

  const isReplay = location.pathname.includes('/replay')
  const isKronorium = location.pathname.startsWith('/kronorium')

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        checkAllHealth()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [checkAllHealth])

  if (isReplay) {
    // Replay (Apple Music Replay-style year-in-review) is intentionally always dark.
    // Don't swap bg-[#08080f] for bg-background - the override is by design.
    return (
      <div className="min-h-screen bg-[#08080f] flex flex-col overflow-hidden">
        <main id="main-content" className="flex-1 overflow-hidden">{children}</main>
        <LazyCommandPalette />
      </div>
    )
  }

  if (isKronorium) {
    return <>{children}</>
  }

  return (
    <div data-theme-part="app-shell" className="h-[100dvh] bg-background flex flex-col overflow-hidden md:h-auto md:min-h-[100dvh] md:overflow-visible pt-[env(safe-area-inset-top,0px)]">
      <svg width="0" height="0" className="absolute">
        <defs>
          <filter id="squircle">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
            <feColorMatrix in="blur" mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9"
              result="squircle" />
            <feComposite in="SourceGraphic" in2="squircle" operator="atop" />
          </filter>
        </defs>
      </svg>
      <SyncIdReminder />
      <ReauthBanner />
      <Header />
      <main id="main-content" className="relative z-10 max-w-[1800px] mx-auto w-full px-4 py-6 md:py-10 flex-1 overflow-y-auto md:overflow-visible">{children}</main>
      <MobileBottomNav />
      <Footer className="hidden md:block" />
      <LazyCommandPalette />
    </div>
  )
}

