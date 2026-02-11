import { ReactNode, useEffect } from 'react'
import { Footer } from './Footer'
import { Header } from './Header'
import { useAddonStore } from '@/store/addonStore'

interface LayoutProps {
  children: ReactNode
}

export function Layout({ children }: LayoutProps) {
  const { checkAllHealth } = useAddonStore()

  // Global Ctrl+K / Cmd+K shortcut to focus page search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Focus search input
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        const searchInput = document.querySelector<HTMLInputElement>('[data-search-focus]')
        if (searchInput) {
          searchInput.focus()
          searchInput.select()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Auto-refresh health when window is focused (with store-level 3m cooldown)
  useEffect(() => {
    const handleFocus = () => {
      checkAllHealth()
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [checkAllHealth])

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />
      <main className="container mx-auto px-4 py-10 flex-1">{children}</main>
      <Footer />
    </div>
  )
}
