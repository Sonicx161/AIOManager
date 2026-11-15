import { Github, Heart, Box, FileText } from 'lucide-react'
import { Link } from 'react-router-dom'
import React from 'react'
import pkg from '../../../package.json'
import { useUIStore } from '@/store/uiStore'
import { isNewerVersion, cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'

const LATEST_RELEASE_KEY = 'aiom:latest-release'
const LATEST_RELEASE_TTL_MS = 6 * 60 * 60 * 1000

export function Footer({ className }: { className?: string }) {
  const isDev = import.meta.env?.DEV
  const version = pkg.version
  const build = (pkg as { build?: number }).build

  const [updateAvailable, setUpdateAvailable] = React.useState<string | null>(null)

  React.useEffect(() => {
    const applyLatest = (latestStr: unknown) => {
      if (typeof latestStr !== 'string' || !latestStr) return
      const currentStr = `${version}${build ? `+build.${build}` : ''}`

      // Use the strict semver utility to prevent +build tags from triggering downgradable updates
      if (isNewerVersion(currentStr, latestStr) && version !== 'Dev') {
        setUpdateAvailable(latestStr.replace('v', ''))
      }
    }

    const checkUpdate = async () => {
      try {
        const cached = JSON.parse(localStorage.getItem(LATEST_RELEASE_KEY) || 'null')
        if (cached && typeof cached.at === 'number' && Date.now() - cached.at < LATEST_RELEASE_TTL_MS) {
          applyLatest(cached.tag)
          return
        }
      } catch {}
      try {
        const res = await fetch('https://api.github.com/repos/sonicx161/AIOManager/releases/latest')
        if (res.ok) {
          const data = await res.json()
          applyLatest(data.tag_name)
          try {
            localStorage.setItem(LATEST_RELEASE_KEY, JSON.stringify({ tag: data.tag_name, at: Date.now() }))
          } catch {}
        }
      } catch {}
    }

    if (!isDev) checkUpdate()
  }, [isDev, version, build])

  return (
    <footer className={cn("mt-auto px-3 pt-5 sm:px-4", className)}>
      <div data-theme-part="app-footer" className="glass-header mx-auto w-full max-w-[1800px] rounded-t-3xl border border-b-0 border-border/40 px-4 py-4 shadow-[inset_0_0.5px_0_hsl(0_0%_100%/0.06),0_-18px_60px_hsl(var(--background)/0.35)]">
        <div className="flex flex-col items-center justify-between gap-4 md:flex-row">
          <nav
            data-theme-part="footer-nav"
            aria-label="Footer links"
            className="inline-flex w-full flex-wrap items-center justify-center gap-1 rounded-2xl border border-border/40 bg-white/[0.04] p-1.5 shadow-[inset_0_0.5px_0_hsl(0_0%_100%/0.06)] md:w-auto"
          >
            <a
              data-theme-part="nav-item"
              href="https://torbox.app/subscription?referral=a7aecfd0-57c8-48fa-9e49-2904f09d57d2"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
            >
              <Box className="h-3.5 w-3.5" />
              TorBox
            </a>
            <a
              data-theme-part="nav-item"
              href="https://github.com/sonicx161/AIOManager"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
            >
              <Github className="h-3.5 w-3.5" />
              Source
            </a>
            <Link
              data-theme-part="nav-item"
              to="/kronorium/project/credits"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
            >
              <FileText className="h-3.5 w-3.5" />
              Credits
            </Link>
            <Link
              data-theme-part="nav-item"
              to="/kronorium/project/support"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
            >
              <Heart className="h-3.5 w-3.5" />
              Support
            </Link>
          </nav>

          <div data-theme-part="panel" className="inline-flex max-w-full flex-wrap items-center justify-center overflow-hidden rounded-xl border border-border/40 bg-white/[0.04] text-xs font-semibold uppercase tracking-[0.05em] shadow-[inset_0_0.5px_0_hsl(0_0%_100%/0.06)]">
            <Tooltip content="Developer GitHub Profile" side="top">
              <a data-theme-part="nav-item"
                href="https://github.com/sonicx161"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center gap-1.5 px-3 text-muted-foreground transition-colors hover:text-foreground"
              >
                Made with <Heart className="h-3 w-3 fill-primary text-primary" /> by <span className="text-primary">Sonicx161</span>
              </a>
            </Tooltip>
            <span className="h-4 w-px bg-border/70" />
            <Tooltip content="View release notes" side="top">
              <button
                data-theme-part="button"
                data-variant="ghost"
                onClick={() => useUIStore.getState().setWhatsNewOpen(true)}
                className="inline-flex h-8 items-center gap-1.5 px-3 font-mono text-muted-foreground transition-colors hover:text-primary"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                v{version}
              </button>
            </Tooltip>
            {build && (
              <>
                <span className="h-4 w-px bg-border/70" />
                <span className="inline-flex h-8 items-center px-3 text-muted-foreground">
                  Build <span className="ml-1 font-mono text-foreground">{build}</span>
                </span>
              </>
            )}
            {updateAvailable && (
              <>
                <span className="h-4 w-px bg-border/70" />
                <a data-theme-part="nav-item"
                  href="https://github.com/sonicx161/AIOManager/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center px-3 text-primary transition-colors hover:bg-primary/10"
                >
                  Update v{updateAvailable}
                </a>
              </>
            )}
          </div>
        </div>
      </div>
    </footer>
  )
}
