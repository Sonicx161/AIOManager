import { type ReactNode, lazy, useEffect, useLayoutEffect, useMemo } from 'react'
import '@/styles/kronorium.css'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { Search, Github, Heart, Box } from 'lucide-react'
import { RootProvider } from 'fumadocs-ui/provider/base'
// Lazy so the search dialog + its markdown renderer (rehype-raw, unist-util-visit, etc.) split out
// of the layout chunk. fumadocs mounts it inside Suspense and only on first open, and preloads it.
const KronoriumSearchDialog = lazy(() => import('@/components/kronorium/KronoriumSearchDialog'))
import { FrameworkProvider } from 'fumadocs-core/framework'
import { useSearchContext } from 'fumadocs-ui/contexts/search'
import { source } from '@/lib/source'
import { baseOptions } from '@/lib/layout.shared'

export function KronoriumDocsLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add('kronorium-active');
    return () => root.classList.remove('kronorium-active');
  }, []);

  const isExternal = (url: string) => /^https?:\/\/|^\/\//.test(url);

  const framework = useMemo(() => ({
    usePathname: () => location.pathname,
    useParams: () => params as Record<string, string | string[]>,
    useRouter: () => ({
      push: (url: string) => {
        if (isExternal(url)) {
          window.location.href = url;
          return;
        }
        navigate(url);
      },
      replace: (url: string) => {
        if (isExternal(url)) {
          window.location.replace(url);
          return;
        }
        navigate(url, { replace: true });
      },
      refresh: () => window.location.reload(),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Link: ({ href, children, ...props }: any) => {
      if (typeof href === 'string' && isExternal(href)) {
        return <a href={href} {...props}>{children}</a>;
      }
      return <Link to={href} {...props}>{children}</Link>;
    },
  }), [location.pathname, params, navigate]);

  return (
    <div id="kronorium-root" data-theme="dark">
      <FrameworkProvider {...framework}>
        <RootProvider 
          theme={{ attribute: 'data-theme', storageKey: 'kronorium-theme', defaultTheme: 'dark', forcedTheme: 'dark' }}
          search={{ SearchDialog: KronoriumSearchDialog, preload: false }}
        >
          <KronoriumContent location={location} children={children} />
        </RootProvider>
      </FrameworkProvider>
    </div>
  );
}

function KronoriumContent({ location, children }: { location: { pathname: string }, children: ReactNode }) {
    const isHome = location.pathname.replace(/\/$/, '') === '/kronorium';
    const search = useSearchContext();
    const { open: searchOpen, setOpenSearch } = search;

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return
            if (e.defaultPrevented) return
            e.preventDefault()
            setOpenSearch(!searchOpen)
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
    }, [searchOpen, setOpenSearch])

    if (isHome) {
        return (
            <div className="flex flex-col min-h-screen">
                <div className="h-14 border-b border-fd-border/50 bg-fd-background/95 sticky top-0 z-50">
                    <div className="max-w-[1400px] mx-auto h-full flex items-center justify-between px-4 sm:px-6">
                        <div className="flex items-center gap-2">
                            {baseOptions().nav?.title as ReactNode}
                        </div>
                        <div className="flex items-center gap-3 sm:gap-5">
                            <button 
                                onClick={() => search.setOpenSearch(true)}
                                className="hidden md:flex items-center gap-3 px-3 py-1.25 rounded-lg border border-fd-border/50 bg-fd-muted/30 hover:bg-fd-muted/50 transition-all text-fd-muted-foreground/60 group/search min-w-[200px]"
                            >
                                <Search className="h-3.5 w-3.5 group-hover/search:text-fd-foreground transition-colors" />
                                <span className="text-xs font-medium group-hover/search:text-fd-foreground transition-colors flex-1 text-left">Search</span>
                                <div className="flex items-center gap-1 opacity-40">
                                    <span className="text-xs font-bold border border-fd-border px-1 rounded bg-fd-muted/50">Ctrl</span>
                                    <span className="text-xs font-bold border border-fd-border px-1.5 rounded bg-fd-muted/50">K</span>
                                </div>
                            </button>
                            <div className="flex items-center h-9">
                                <a aria-label="TorBox" href="https://torbox.app/subscription?referral=a7aecfd0-57c8-48fa-9e49-2904f09d57d2" target="_blank" rel="noopener noreferrer" className="h-9 w-9 flex items-center justify-center rounded-full text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/20 transition-all">
                                    <Box className="h-4.5 w-4.5" />
                                </a>
                                <a aria-label="Donate" href="https://ko-fi.com/sonicx161" target="_blank" rel="noopener noreferrer" className="h-9 w-9 flex items-center justify-center rounded-full text-fd-muted-foreground hover:text-fd-primary hover:bg-fd-accent/20 transition-all">
                                    <Heart className="h-4.5 w-4.5" />
                                </a>
                                <a aria-label="GitHub" href="https://github.com/sonicx161/AIOManager" target="_blank" rel="noopener noreferrer" className="h-9 w-9 flex items-center justify-center rounded-full text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/20 transition-all">
                                    <Github className="h-4.5 w-4.5" />
                                </a>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="flex-1">
                    {children}
                </div>
            </div>
        );
    }

    return (
        <>
            <DocsLayout
                tree={source.pageTree}
                {...baseOptions()}
            >
                {children}
            </DocsLayout>
        </>
    );
}
