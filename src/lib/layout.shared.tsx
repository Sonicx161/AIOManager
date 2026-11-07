import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { Github, Box, ArrowLeft } from 'lucide-react'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <div className="flex items-center gap-2.5 group/brand">
          <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
            <img
              src="/logo.png"
              alt="AIOManager"
              loading="lazy"
              className="h-full w-full object-contain brightness-0 invert"
            />
          </span>
          <span className="font-semibold text-base tracking-tight text-foreground transition-colors group-hover/brand:opacity-80">AIOManager</span>
        </div>
      ),
      url: '/kronorium',
      transparentMode: 'top',
    },
    links: [
      {
        icon: <ArrowLeft className="h-4 w-4" />,
        text: 'Back to App',
        label: 'Back to App',
        url: '/',
        type: 'icon',
      },
      {
        icon: <Box className="h-4 w-4" />,
        text: 'TorBox',
        label: 'TorBox',
        url: 'https://torbox.app/subscription?referral=a7aecfd0-57c8-48fa-9e49-2904f09d57d2',
        type: 'icon',
      },
      {
        icon: <Github className="h-4 w-4" />,
        text: 'GitHub',
        label: 'GitHub',
        url: 'https://github.com/sonicx161/AIOManager',
        type: 'icon',
      },
      {
        icon: <span className="text-destructive">❤️</span>,
        text: 'Donate',
        label: 'Donate',
        url: 'https://ko-fi.com/sonicx161',
        type: 'icon',
      }
    ],
  }
}
