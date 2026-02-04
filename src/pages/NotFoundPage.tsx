import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/contexts/ThemeContext'
import { Home } from 'lucide-react'

export function NotFoundPage() {
  const { theme } = useTheme()
  const isInverted = theme === 'light' || theme === 'hoth'

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-4">
      <div className="max-w-md w-full text-center space-y-8 animate-in fade-in zoom-in duration-500">
        <div className="relative inline-block">
          <img
            src="/logo.png"
            alt="AIOManager Logo"
            className={`h-24 w-24 md:h-32 md:w-32 mx-auto object-contain transition-all mb-4 ${isInverted ? 'invert' : ''}`}
          />
          <div className="absolute -top-2 -right-2 bg-destructive text-destructive-foreground text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-tighter">
            Error
          </div>
        </div>

        <div className="space-y-4">
          <h1 className="text-6xl md:text-8xl font-black tracking-tighter text-muted-foreground/20 italic select-none">
            404
          </h1>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">
            You've reached a dead end.
          </h2>
          <p className="text-muted-foreground text-sm md:text-base text-balance italic">
            "Even the best aggregators sometimes lose a stream. The page you're looking for has been purged or moved."
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 pt-4 sm:justify-center">
          <Button asChild variant="default" size="lg" className="w-full sm:w-auto">
            <Link to="/">
              <Home className="mr-2 h-4 w-4" />
              Return Home
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="w-full sm:w-auto"
            onClick={() => window.history.back()}
          >
            Go Back
          </Button>
        </div>
      </div>
    </div>
  )
}
