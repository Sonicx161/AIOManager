import { Link, useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/contexts/ThemeContext'
import { BrandLogo } from '@/components/common/BrandLogo'
import { ArrowLeft, Home } from 'lucide-react'
import { useDocumentTitle } from '@/hooks/use-document-title'

export function NotFoundPage() {
  useDocumentTitle('404')
  const { logoUrl } = useTheme()
  const location = useLocation()
  const requestedPath = (location.state as { from?: string } | null)?.from ?? location.pathname

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-4">
      <section
        data-theme-part="card"
        className="w-full max-w-lg rounded-xl border border-border/40 bg-card p-6 text-center shadow-sm animate-in fade-in zoom-in-95 duration-300 sm:p-8"
        aria-labelledby="not-found-title"
      >
        <BrandLogo logoUrl={logoUrl} className="mx-auto h-20 w-20 text-foreground" />

        <div className="mt-6 space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase">404</p>
          <h1 id="not-found-title" className="text-2xl font-bold tracking-tight">
            This page is not available.
          </h1>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            The link may have moved, expired, or never existed.
          </p>
          <p data-theme-part="field" className="mx-auto max-w-sm truncate rounded-lg border border-border/40 bg-muted/20 px-3 py-2 font-mono text-xs text-muted-foreground">
            {requestedPath}
          </p>
        </div>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button asChild variant="default" size="lg" className="w-full gap-2 rounded-full sm:w-auto">
            <Link to="/">
              <Home className="h-4 w-4" />
              Return home
            </Link>
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="w-full gap-2 rounded-full sm:w-auto"
            onClick={() => window.history.back()}
          >
            <ArrowLeft className="h-4 w-4" />
            Go back
          </Button>
        </div>
      </section>
    </div>
  )
}
