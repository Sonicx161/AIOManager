import { ReactNode, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { Footer } from './Footer'
import { Header } from './Header'
import { SyncIdReminder } from './SyncIdReminder'
import { useAddonStore } from '@/store/addonStore'
import { CommandPalette } from '@/components/CommandPalette'

interface LayoutProps {
  children: ReactNode
}

export function Layout({ children }: LayoutProps) {
  const { checkAllHealth } = useAddonStore()
  const location = useLocation()

  // Use a more robust check for Replay mode
  const isReplay = location.pathname.includes('/replay')

  // Auto-refresh health when window is focused (with store-level 3m cooldown)
  useEffect(() => {
    const handleFocus = () => {
      checkAllHealth()
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [checkAllHealth])

  if (isReplay) {
    return (
      <div className="min-h-screen bg-[#08080f] flex flex-col overflow-hidden">
        <main className="flex-1 overflow-hidden">{children}</main>
        <CommandPalette />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background flex flex-col pb-20 md:pb-0">
      <SyncIdReminder />
      <Header />
      <main className="container mx-auto px-4 py-6 md:py-10 flex-1">{children}</main>
      <Footer />
      <CommandPalette />
    </div>
  )
}

