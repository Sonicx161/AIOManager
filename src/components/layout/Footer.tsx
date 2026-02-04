import { Github, Laptop, Heart, Box, FileText } from 'lucide-react'
import { Link } from 'react-router-dom'
import React from 'react'
import pkg from '../../../package.json'

export function Footer() {
  const isDev = import.meta.env?.DEV
  const version = pkg.version

  const [updateAvailable, setUpdateAvailable] = React.useState<string | null>(null)

  React.useEffect(() => {
    // Simple GitHub Release check
    const checkUpdate = async () => {
      try {
        const res = await fetch('https://api.github.com/repos/sonicx161/AIOManager/releases/latest')
        if (res.ok) {
          const data = await res.json()
          // Assuming tag_name is like 'v1.0.0' or '1.0.0'
          const latest = data.tag_name.replace('v', '')
          const current = version.replace('v', '')

          if (latest !== current && current !== 'Dev') {
            setUpdateAvailable(latest)
          }
        }
      } catch (e) {
        // Silent fail
      }
    }

    if (!isDev) checkUpdate()
  }, [isDev, version])

  return (
    <>
      <footer className="border-t border-border bg-card/30 mt-auto">
        <div className="container mx-auto px-4 py-8">
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-2 md:flex md:items-center md:justify-center gap-2 sm:gap-4">
              <a
                href="https://torbox.app/subscription?referral=a7aecfd0-57c8-48fa-9e49-2904f09d57d2"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-150 border md:border-transparent"
              >
                <Box className="h-4 w-4" />
                TorBox
              </a>
              <a
                href="https://github.com/sonicx161/AIOManager"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-150 border md:border-transparent"
              >
                <Github className="h-4 w-4" />
                Source
              </a>
              <Link
                to="/faq#credits"
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-150 border md:border-transparent"
              >
                <FileText className="h-4 w-4" />
                Credits
              </Link>
              <a
                href="https://ko-fi.com/sonicx161"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-150 border md:border-transparent"
              >
                <Heart className="h-4 w-4" />
                Donate
              </a>
            </div>

            <div className="flex flex-col items-center justify-center gap-2 text-center">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Made with ❤️ by</span>
                <a
                  href="https://sonicx161.vercel.app/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline font-medium"
                  title="Brand & Communities"
                >
                  Sonicx161
                </a>
                <span className="text-muted-foreground/30">•</span>
                <div className="flex items-center gap-2">
                  <a
                    href="https://chrise.vercel.app/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-primary transition-colors"
                    title="Engineering Portfolio"
                  >
                    <Laptop className="h-4 w-4" />
                  </a>
                  <span className="text-muted-foreground/30">•</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] sm:text-xs font-mono text-muted-foreground/40 select-none uppercase tracking-widest">
                      v{version}
                    </span>
                    {updateAvailable && (
                      <a
                        href="https://github.com/sonicx161/AIOManager/releases"
                        target="_blank"
                        rel="noreferrer"
                        className="bg-primary/10 text-primary hover:bg-primary/20 text-[10px] px-1.5 py-0.5 rounded font-medium transition-colors"
                      >
                        Update: v{updateAvailable}
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </>
  )
}
