import { AlertTriangle, Info, Lightbulb, Copy, Check, ChevronDown, ArrowRight, Rocket, Book, FileCode, Code, ArrowUpCircle, GitBranch, Heart, Settings2, Users, Puzzle, Zap, MoreVertical, RefreshCw, RotateCw, Eye, EyeOff, ExternalLink, List, Pencil, Trash2, FlaskConical, ShieldCheck, Clock, WrenchIcon, Home } from 'lucide-react'
import { useState, type SVGProps } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'

export function Note({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex gap-3.5 p-4.5 rounded-xl bg-fd-primary/5 border border-fd-primary/10 my-6 shadow-sm border-l-4 border-l-fd-primary/40">
            <Info className="h-4 w-4 text-fd-primary shrink-0 mt-0.5" />
            <div className="text-sm text-fd-muted-foreground leading-relaxed font-medium">{children}</div>
        </div>
    )
}

export function Warning({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex gap-3.5 p-4.5 rounded-xl bg-warning/5 border border-warning/10 my-6 shadow-sm border-l-4 border-l-warning/40">
            <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
            <div className="text-sm text-fd-muted-foreground leading-relaxed font-medium">{children}</div>
        </div>
    )
}

export function Tip({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex gap-3.5 p-4.5 rounded-xl bg-success/5 border border-success/10 my-6 shadow-sm border-l-4 border-l-success/40">
            <Lightbulb className="h-4 w-4 text-success shrink-0 mt-0.5" />
            <div className="text-sm text-fd-muted-foreground leading-relaxed font-medium">{children}</div>
        </div>
    )
}

export function CodeBlock({ children, language }: { children: string; language?: string }) {
    const [copied, setCopied] = useState(false)
    const copy = () => {
        navigator.clipboard.writeText(children)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }
    return (
        <div className="relative group my-4 rounded-lg border border-border overflow-hidden">
            {language && (
                <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border">
                    <span className="text-xs uppercase text-muted-foreground/60 font-mono">{language}</span>
                    <Button onClick={copy} variant="ghost" size="sm" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                        {copied ? 'Copied' : 'Copy'}
                    </Button>
                </div>
            )}
            {!language && (
                <Button onClick={copy} variant="outline" size="sm" className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? 'Copied' : 'Copy'}
                </Button>
            )}
            <pre className="p-4 text-xs font-mono overflow-x-auto text-muted-foreground bg-muted/20 leading-relaxed">
                <code>{children}</code>
            </pre>
        </div>
    )
}

export function Steps({ children }: { children: React.ReactNode }) {
    return <ol className="space-y-4 my-4 list-none pl-0">{children}</ol>
}

export function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
    const hasChildren = children !== null && children !== undefined && children !== ''
    return (
        <li className="flex gap-3 items-start">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-xs font-bold text-primary mt-0.5">{n}</div>
            <div className="flex-1 pt-0.5 text-sm leading-relaxed">
                {hasChildren ? (
                    <><span className="font-semibold text-foreground">{title}: </span><span className="text-muted-foreground">{children}</span></>
                ) : (
                    <span className="text-foreground">{title}</span>
                )}
            </div>
        </li>
    )
}

export function PageTitle({ title, description }: { title: string; description: string }) {
    return (
        <div className="mb-8 pb-6 border-b border-border">
            <h1 className="text-3xl font-bold tracking-tight mb-2">{title}</h1>
            <p className="text-muted-foreground">{description}</p>
        </div>
    )
}

export function SectionHeading({ id, level = 2, children }: { id: string; level?: 2 | 3; children: React.ReactNode }) {
    const Tag = `h${level}` as 'h2' | 'h3'
    return (
        <Tag id={id} className={cn('scroll-mt-24 font-bold tracking-tight', level === 2 ? 'text-xl mt-10 mb-4' : 'text-base mt-6 mb-3')}>
            {children}
        </Tag>
    )
}

export function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
    return (
        <div className="my-4 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
                <thead>
                    <tr className="border-b border-border bg-muted/30">
                        {headers.map(h => <th key={h} className="text-left px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-muted-foreground/70">{h}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, i) => (
                        <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors">
                            {row.map((cell, j) => <td key={j} className="px-4 py-3 text-muted-foreground">{cell}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

interface TabItem {
    label: string
    content: React.ReactNode
}

export function Tabs({ tabs, defaultIndex = 0 }: { tabs: TabItem[]; defaultIndex?: number }) {
    const [active, setActive] = useState(defaultIndex)
    return (
        <div className="my-4 rounded-lg border border-border overflow-hidden">
            <div className="flex border-b border-border bg-muted/30 overflow-x-auto">
                {tabs.map((tab, i) => (
                    <button
                        key={tab.label}
                        onClick={() => setActive(i)}
                        className={cn(
                            'px-4 py-2.5 text-xs font-bold uppercase transition-all whitespace-nowrap border-b-2 -mb-px',
                            active === i
                                ? 'text-primary border-primary bg-background/50'
                                : 'text-muted-foreground hover:text-foreground border-transparent hover:bg-muted/30'
                        )}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className="p-4">{tabs[active]?.content}</div>
        </div>
    )
}


interface AccordionItem {
    title: string
    content: React.ReactNode
}

export function Accordion({ items }: { items: AccordionItem[] }) {
    const [openIndex, setOpenIndex] = useState<number | null>(null)
    return (
        <div className="my-4 rounded-lg border border-border divide-y divide-border overflow-hidden">
            {items.map((item, i) => (
                <div key={i}>
                    <button
                        onClick={() => setOpenIndex(openIndex === i ? null : i)}
                        className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-foreground hover:bg-muted/30 transition-colors"
                    >
                        <span>{item.title}</span>
                        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform duration-200', openIndex === i && 'rotate-180')} />
                    </button>
                    <div className={cn('overflow-hidden transition-all duration-200', openIndex === i ? 'max-h-[2000px]' : 'max-h-0')}>
                        <div className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed">
                            {item.content}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    )
}


interface FlowStep {
    emoji: string
    label: string
    sublabel?: string
    color?: string
}

export function MockupFlow({ steps, vertical = false }: { steps: FlowStep[]; vertical?: boolean }) {
    return (
        <div className={cn(
            'my-6 p-5 rounded-xl border border-border bg-card/50 flex items-center gap-2 overflow-x-auto',
            vertical && 'flex-col'
        )}>
            {steps.map((step, i) => (
                <div key={i} className={cn('flex items-center gap-2', vertical && 'flex-col')}>
                    <div className="flex flex-col items-center gap-1.5 shrink-0">
                        <div className={cn(
                            'w-12 h-12 rounded-xl flex items-center justify-center text-xl border shadow-sm',
                            step.color || 'bg-primary/10 border-primary/20'
                        )}>
                            {step.emoji}
                        </div>
                        <span className="text-xs font-semibold text-foreground text-center max-w-[80px] leading-tight">{step.label}</span>
                        {step.sublabel && <span className="text-xs text-muted-foreground/60 text-center max-w-[80px] leading-tight">{step.sublabel}</span>}
                    </div>
                    {i < steps.length - 1 && (
                        <ArrowRight className={cn('h-4 w-4 text-muted-foreground/30 shrink-0', vertical && 'rotate-90')} />
                    )}
                </div>
            ))}
        </div>
    )
}


export function MockupToggle({ before, after, beforeLabel = 'Before', afterLabel = 'After' }: {
    before: React.ReactNode
    after: React.ReactNode
    beforeLabel?: string
    afterLabel?: string
}) {
    const [showAfter, setShowAfter] = useState(false)
    return (
        <div className="my-4 rounded-xl border border-border overflow-hidden">
            <div className="flex border-b border-border bg-muted/30">
                <button
                    onClick={() => setShowAfter(false)}
                    className={cn(
                        'flex-1 px-4 py-2.5 text-xs font-bold uppercase transition-all border-b-2 -mb-px',
                        !showAfter ? 'text-primary border-primary bg-background/50' : 'text-muted-foreground border-transparent hover:text-foreground'
                    )}
                >
                    {beforeLabel}
                </button>
                <button
                    onClick={() => setShowAfter(true)}
                    className={cn(
                        'flex-1 px-4 py-2.5 text-xs font-bold uppercase transition-all border-b-2 -mb-px',
                        showAfter ? 'text-success border-success bg-background/50' : 'text-muted-foreground border-transparent hover:text-foreground'
                    )}
                >
                    {afterLabel}
                </button>
            </div>
            <div className="p-4 transition-all duration-200">
                {showAfter ? after : before}
            </div>
        </div>
    )
}


import { Link as RouterLink } from 'react-router-dom'

export function Hero() {
    return (
        <div className="flex flex-col items-center justify-center text-center py-24 gap-6">
            <h1 className="text-6xl font-bold tracking-tight md:text-8xl bg-gradient-to-b from-fd-foreground to-fd-foreground/70 bg-clip-text text-transparent leading-[1.05]">
                The AIOManager <br /> Kronorium
            </h1>
            <p className="text-fd-muted-foreground max-w-xl text-lg md:text-xl leading-relaxed font-medium">
                One manager to rule them all - local-first, encrypted, and powerful. Manage multiple streaming accounts, addons, and automated failover.
            </p>
            <div className="flex gap-3 flex-wrap justify-center mt-4">
                <RouterLink
                    to="/kronorium/getting-started"
                    className="inline-flex items-center gap-2 rounded-md bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground transition-all hover:bg-fd-primary/90 shadow-lg shadow-fd-primary/10"
                >
                    Read the docs
                </RouterLink>
                <a
                    href="https://github.com/sonicx161/AIOManager"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-md border border-fd-border bg-fd-card/50 px-5 py-2.5 text-sm font-semibold transition-all hover:bg-fd-muted"
                >
                    <Github className="h-4 w-4" />
                    GitHub
                </a>
                <a
                    href="https://ko-fi.com/sonicx161"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-md border border-fd-border bg-fd-card/50 px-5 py-2.5 text-sm font-semibold transition-all hover:bg-fd-muted"
                >
                    <Heart className="h-4 w-4 text-destructive" />
                    Donate
                </a>
                <RouterLink
                    to="/"
                    className="inline-flex items-center gap-2 rounded-md border border-fd-border bg-fd-card/50 px-5 py-2.5 text-sm font-semibold transition-all hover:bg-fd-muted"
                >
                    <Home className="h-4 w-4" />
                    Back to AIOManager
                </RouterLink>
            </div>
        </div>
    )
}

export function NavCards({ children }: { children: React.ReactNode }) {
    return (
        <div className="px-1 pb-16 w-full mt-12">
            <p className="text-xs font-bold uppercase text-fd-muted-foreground mb-6">
                Explore the docs
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {children}
            </div>
        </div>
    )
}

export function NavCard({
    href,
    title,
    description,
    icon: IconName,
}: {
    href: string
    title: string
    description: string
    icon: 'Rocket' | 'Book' | 'FileCode' | 'Code' | 'ArrowUpCircle' | 'GitBranch' | 'Settings' | 'Users' | 'Puzzle' | 'Zap'
}) {
    const Icons = {
        Rocket,
        Book,
        FileCode,
        Code,
        ArrowUpCircle,
        GitBranch,
        Settings: Settings2,
        Users,
        Puzzle,
        Zap,
    }
    const Icon = Icons[IconName] || Book

    return (
        <RouterLink
            to={href}
            className="group flex flex-col gap-4 rounded-xl border border-fd-border bg-fd-card/40 p-5 text-left transition-all hover:border-fd-primary/30 hover:bg-fd-muted/50 hover:translate-y-[-2px] shadow-sm"
        >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-fd-border/50 bg-fd-muted/50 text-fd-primary transition-colors group-hover:border-fd-primary/30 shadow-sm">
                <Icon className="h-5 w-5" />
            </div>
            <div>
                <p className="text-sm font-bold text-fd-foreground group-hover:text-fd-primary transition-colors">{title}</p>
                <p className="mt-1.5 text-sm text-fd-muted-foreground leading-relaxed line-clamp-2 font-medium opacity-80">{description}</p>
            </div>
        </RouterLink>
    )
}


function Github(props: SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
            <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
            <path d="M9 18c-4.51 2-5-2-7-2" />
        </svg>
    )
}



export function DemoAddonCard({
    name,
    version = 'v1.0.0',
    description,
    url = 'https://addon.example.com/manifest.json',
    initialEnabled = true,
    badge,
    protected: isProtected = false,
    hasCatalogs = true,
    canSave = true,
}: {
    name: string
    version?: string
    description?: string
    url?: string
    initialEnabled?: boolean
    badge?: 'primary' | 'primary-paused' | 'backup' | 'backup-paused'
    protected?: boolean
    hasCatalogs?: boolean
    canSave?: boolean
}) {
    const [enabled, setEnabled] = useState(initialEnabled)
    const [copied, setCopied] = useState(false)

    const handleCopy = () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }

    return (
        <div className={cn(
            "rounded-xl border bg-fd-card/50 backdrop-blur-sm shadow-md transition-all duration-300 group/addon",
            !enabled ? 'opacity-40 grayscale-[0.5]' : 'opacity-100',
            isProtected ? 'border-fd-primary/30 shadow-fd-primary/5' : 'border-fd-border hover:border-fd-primary/40'
        )}>
            <div className="flex flex-row items-center justify-between p-4 pb-2">
                <div className="flex items-center gap-3.5 min-w-0">
                    <div className="bg-fd-muted p-1.5 rounded-xl shrink-0 border border-fd-border/50 shadow-sm group-hover/addon:border-fd-primary/30 transition-colors">
                        <div className="w-11 h-11 rounded-lg bg-fd-primary/10 flex items-center justify-center text-xl font-bold text-fd-primary">
                            {name[0]}
                        </div>
                    </div>
                    <div className="flex flex-col min-w-0">
                        <span className="text-base font-semibold truncate leading-tight text-foreground">{name}</span>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                            <span className="text-xs text-muted-foreground truncate">v{version}</span>
                            <Tooltip content="Online" side="top"><span className="w-2 h-2 rounded-full bg-success" /></Tooltip>
                            {isProtected && (
                                <span className="inline-flex items-center px-1 py-0.5 rounded text-xs bg-success/10 text-success">Protected</span>
                            )}
                            {badge === 'primary' && (
                                <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded-full border bg-primary/10 border-primary/20 text-primary/80">
                                    <span className="w-1 h-1 rounded-full bg-primary/60" /> Primary
                                </span>
                            )}
                            {badge === 'primary-paused' && (
                                <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded-full border bg-muted/40 border-border/40 text-muted-foreground/60">
                                    <span className="w-1 h-1 rounded-full bg-muted-foreground/40" /> Primary · Paused
                                </span>
                            )}
                            {badge === 'backup' && (
                                <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded-full border bg-primary/10 border-primary/20 text-primary/80">
                                    <span className="w-1 h-1 rounded-full bg-primary/60" /> Failover backup
                                </span>
                            )}
                            {badge === 'backup-paused' && (
                                <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded-full border bg-muted/40 border-border/40 text-muted-foreground/60">
                                    <span className="w-1 h-1 rounded-full bg-muted-foreground/40" /> Failover backup · Paused
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                    <div className="flex items-center gap-2 mr-2">
                        <div
                            onClick={() => setEnabled(v => !v)}
                            className={cn(
                                'relative w-9 h-5 rounded-full transition-colors cursor-pointer',
                                enabled ? 'bg-success' : 'bg-muted'
                            )}
                        >
                            <div className={cn('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform', enabled && 'translate-x-4')} />
                        </div>
                    </div>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                        <MoreVertical className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            <div className="px-4 py-2">
                <p className="text-sm text-muted-foreground line-clamp-2 mb-3 h-10">
                    {description || `Addon from ${new URL(url).hostname}`}
                </p>
                <div className="flex items-center gap-2 w-full min-w-0">
                    <div className="flex-1 bg-muted/40 rounded px-2 py-1 flex items-center justify-between border min-w-0 overflow-hidden">
                        <span className="text-xs text-muted-foreground font-mono truncate mr-2 flex-grow min-w-0">{url}</span>
                        <Tooltip content="Copy URL" side="top">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleCopy}
                            className="text-muted-foreground hover:text-foreground shrink-0"
                        >
                            {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                        </Button>
                        </Tooltip>
                    </div>
                    <Tooltip content="Open in Stremio" side="top">
                    <Button variant="ghost" size="icon" className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0">
                        <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                    </Tooltip>
                </div>
            </div>

            <div className="flex flex-col gap-2 px-4 py-3 border-t bg-muted/5">
                <div className="grid grid-cols-2 gap-1.5 w-full">
                    <Button variant="outline" size="sm" className="h-8 text-xs font-semibold gap-1.5">
                        <Settings2 className="h-3.5 w-3.5" /> Configure
                    </Button>
                    <Button variant="outline" size="sm" className={cn(
                        'h-8 text-xs font-semibold gap-1.5',
                        !hasCatalogs && 'opacity-50 cursor-not-allowed'
                    )}>
                        <List className="h-3.5 w-3.5" /> Catalogs
                    </Button>
                    <Button variant="outline" size="sm" className="h-8 text-xs font-semibold gap-1.5">
                        <Pencil className="h-3.5 w-3.5" /> Customize
                    </Button>
                    {canSave ? (
                        <Button variant="outline" size="sm" className="h-8 text-xs font-semibold gap-1.5">
                            <Heart className="h-3.5 w-3.5" /> Save to Library
                        </Button>
                    ) : (
                        <Button variant="outline" size="sm" className="h-8 text-xs font-semibold gap-1.5">
                            <RefreshCw className="h-3.5 w-3.5" /> Reinstall
                        </Button>
                    )}
                </div>
                {!isProtected && (
                    <Button variant="destructive" size="sm" className="w-full mt-1 h-9 text-xs font-bold gap-2">
                        <Trash2 className="h-4 w-4" /> Remove Addon
                    </Button>
                )}
            </div>
        </div>
    )
}

export function DemoFailoverChain() {
    const [activeIndex, setActiveIndex] = useState(0)
    const [paused, setPaused] = useState(false)
    const [simulating, setSimulating] = useState(false)
    const [simResults, setSimResults] = useState<Record<number, 'healthy' | 'unhealthy' | 'checking'>>({})

    const addons = [
        { name: 'AIOStreams (Primary)', url: 'stream.myserver.com/••••' },
        { name: 'AIOStreams (Backup)', url: 'stream.elfhosted.com/••••' },
        { name: 'AIOStreams (Emergency)', url: 'stream.backup2.com/••••' },
    ]

    const handleSimulate = () => {
        setSimulating(true)
        setSimResults({})
        const total = addons.length
        addons.forEach((_, i) => {
            setTimeout(() => {
                setSimResults(prev => ({ ...prev, [i]: 'checking' }))
                setTimeout(() => {
                    setSimResults(prev => ({
                        ...prev,
                        [i]: i === activeIndex ? 'healthy' : (i < activeIndex ? 'unhealthy' : 'healthy')
                    }))
                    if (i === total - 1) {
                        setTimeout(() => setSimulating(false), 800)
                    }
                }, 600)
            }, i * 800)
        })
    }

    const getTierClassName = (isActive: boolean, isTier1: boolean) => {
        if (!isActive) return 'bg-muted/20 border-l-[3px] border-l-transparent'
        if (isTier1) return 'bg-primary/[0.08] border-l-[3px] border-l-primary'
        return 'bg-warning/[0.08] border-l-[3px] border-warning'
    }

    return (
        <div className="my-6 rounded-xl border border-fd-border bg-fd-card/40 backdrop-blur-sm p-6 space-y-7 shadow-sm">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="font-mono text-xs font-semibold text-fd-foreground/40 uppercase bg-fd-foreground/5 px-2.5 py-1 rounded-md border border-fd-border/50">
                        MY STREAMING RULE
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className={cn('text-xs uppercase font-bold', paused ? 'text-foreground/60' : 'text-primary')}>
                        {paused ? 'Disabled' : 'Enabled'}
                    </span>
                    <div
                        onClick={() => setPaused(v => !v)}
                        className={cn('relative w-9 h-5 rounded-full transition-colors cursor-pointer', !paused ? 'bg-primary' : 'bg-muted')}
                    >
                        <div className={cn('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform', !paused && 'translate-x-4')} />
                    </div>
                    <Tooltip content="Simulate Autopilot Health Check" side="top">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleSimulate}
                        className={cn('h-8 w-8', simulating ? 'text-primary' : 'text-foreground/60')}
                    >
                        <FlaskConical className="w-4 h-4" />
                    </Button>
                    </Tooltip>
                </div>
            </div>

            <div className="flex flex-col relative w-full px-2">
                {addons.map((addon, idx) => {
                    const isActive = idx === activeIndex
                    const isTier1 = idx === 0
                    const isFailedOver = isActive && !isTier1

                    return (
                        <div key={idx} className="flex flex-col">
                            <div
                                onClick={() => !paused && setActiveIndex(idx)}
                                className={cn(
                                    'flex items-center gap-4 py-3.5 px-5 rounded-xl relative z-10 transition-all duration-300',
                                    getTierClassName(isActive, isTier1),
                                    !paused && !isActive && 'cursor-pointer hover:bg-fd-muted/40 hover:translate-x-1',
                                    paused && 'opacity-60 grayscale-[0.3]'
                                )}
                            >
                                <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 bg-muted/60">
                                    {idx + 1}
                                </div>
                                <span className="font-bold truncate text-sm flex-1">{addon.name}</span>
                                <div className="flex items-center gap-2 shrink-0">
                                    {isTier1 && <span className="text-xs font-mono font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">PRIMARY</span>}
                                    {isFailedOver && <span className="text-xs font-mono font-bold text-warning bg-warning/10 px-1.5 py-0.5 rounded">ACTIVE</span>}
                                </div>
                            </div>
                            {idx < addons.length - 1 && (
                                <div className="w-full flex justify-center py-1">
                                    <div className="w-px h-4 bg-border relative">
                                        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 border-l-4 border-r-4 border-t-[4px] border-l-transparent border-r-transparent border-t-white/10" />
                                    </div>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>

            {simulating && Object.keys(simResults).length > 0 && (
                <div className="mx-2 p-4 rounded-xl bg-primary/5 border border-primary/20 space-y-3">
                    <div className="flex items-center gap-2 text-primary">
                        <FlaskConical className="w-4 h-4" />
                        <span className="text-xs font-semibold uppercase">Autopilot Simulation</span>
                    </div>
                    <div className="space-y-2">
                        {addons.map((addon, idx) => (
                            <div key={idx} className="flex items-center justify-between text-xs">
                                <div className="flex items-center gap-2 text-foreground/70">
                                    <span className="font-mono text-xs opacity-30">T{idx + 1}</span>
                                    <span className="truncate max-w-[150px]">{addon.name}</span>
                                </div>
                                <div>
                                    {simResults[idx] === 'checking' && <span className="text-primary text-xs">Checking…</span>}
                                    {simResults[idx] === 'healthy' && <span className="text-success text-xs font-bold">✓ Healthy</span>}
                                    {simResults[idx] === 'unhealthy' && <span className="text-destructive text-xs font-bold">✗ Offline</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <p className="text-xs text-muted-foreground/60 text-center">
                Click a tier to switch the active addon • Use the flask to run a simulated health check
            </p>
        </div>
    )
}

export function DemoVaultKey({
    name,
    provider,
    abbr,
    status = 'active',
    daysRemaining,
}: {
    name: string
    provider: string
    abbr?: string
    status?: 'active' | 'expired' | 'expiring'
    daysRemaining?: number
}) {
    const [revealed, setRevealed] = useState(false)
    const [copied, setCopied] = useState(false)
    const fakeKey = '••••••••••••••••••••••••••••••'
    const realKey = 'sk_demo_kronorium_placeholder_key_00'

    const handleCopy = () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }

    return (
        <div className="p-5 rounded-xl border border-fd-border bg-fd-card/50 hover:border-fd-primary/40 backdrop-blur-sm transition-all duration-300 group/vault relative shadow-sm hover:shadow-fd-primary/5">
            <div className="flex flex-col gap-1.5 w-full mb-1">
                <div className="flex items-center justify-between w-full h-8">
                    <div className="flex items-center gap-3 min-w-0 h-full">
                        <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary shrink-0 flex items-center justify-center font-bold text-xs">
                            {abbr || <ShieldCheck className="h-5 w-5" />}
                        </div>
                        <h3 className="font-bold text-sm tracking-tight truncate leading-none">{name}</h3>
                    </div>
                    <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground">
                        <MoreVertical className="h-4 w-4" />
                    </Button>
                </div>

                <div className="flex items-center gap-2 pl-[44px]">
                    <span className="text-xs uppercase font-bold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        {provider}
                    </span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-2.5 w-2.5" />
                        2 days ago
                    </span>
                    {status === 'expiring' && daysRemaining !== undefined && (
                        <span className="text-xs text-warning font-medium">{daysRemaining}d remaining</span>
                    )}
                    {status === 'expired' && (
                        <span className="text-xs text-destructive font-medium">Expired</span>
                    )}
                </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
                <div className="flex-1 bg-muted/50 rounded-lg px-3 py-1.5 flex items-center justify-between border border-border/50">
                    <span className={cn('font-mono text-xs text-muted-foreground', revealed ? 'break-all' : 'truncate max-w-[150px]')}>
                        {revealed ? realKey : fakeKey}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                        <Tooltip content={revealed ? 'Hide key' : 'Show key'} side="top">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setRevealed(v => !v)}
                            className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-primary"
                        >
                            {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </Button>
                        </Tooltip>
                        <Tooltip content="Copy to clipboard" side="top">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleCopy}
                            className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-primary"
                        >
                            {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                        </Button>
                        </Tooltip>
                    </div>
                </div>
            </div>
        </div>
    )
}

export function DemoAccountActions() {
    const [active, setActive] = useState<string | null>(null)

    const actions = [
        {
            id: 'sync',
            icon: RefreshCw,
            label: 'Sync',
            color: 'text-primary',
            desc: 'Pulls the latest addon list from Stremio. Use when you\'ve made changes directly in the Stremio app.',
        },
        {
            id: 'repair',
            icon: WrenchIcon,
            label: 'Repair',
            color: 'text-warning',
            desc: 'Re-downloads all manifests from source URLs. Use when addons show wrong versions or behave unexpectedly.',
        },
        {
            id: 'refresh',
            icon: RotateCw,
            label: 'Refresh Addons',
            color: 'text-primary',
            desc: 'Re-fetches each manifest and pushes updates to your connected platforms. Your custom names and logos are preserved.',
        },
    ]

    return (
        <div className="my-4 rounded-xl border border-border bg-card/50 overflow-hidden">
            <div className="p-1 border-b border-border bg-muted/20">
                <p className="text-xs text-muted-foreground text-center py-1">Click an action to see what it does</p>
            </div>
            <div className="divide-y divide-border">
                {actions.map(action => (
                    <Button
                        key={action.id}
                        variant="ghost"
                        onClick={() => setActive(active === action.id ? null : action.id)}
                        className="w-full flex items-start gap-3 p-3 hover:bg-muted/30 text-left justify-start h-auto"
                    >
                        <action.icon className={`h-4 w-4 mt-0.5 shrink-0 ${action.color}`} />
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground">{action.label}</p>
                            {active === action.id && (
                                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{action.desc}</p>
                            )}
                        </div>
                        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground/60 mt-0.5 transition-transform shrink-0 ${active === action.id ? 'rotate-180' : ''}`} />
                    </Button>
                ))}
            </div>
        </div>
    )
}

export function DemoRuleCard({
    name = 'My Streaming Rule',
    addons = ['AIOStreams (Primary)', 'AIOStreams (Backup)'],
    initialActive = true,
}: {
    name?: string
    addons?: string[]
    initialActive?: boolean
}) {
    const [active, setActive] = useState(initialActive)

    return (
        <div className="my-4 rounded-xl border border-border bg-card/50 p-5 space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Zap className={`h-4 w-4 ${active ? 'text-primary' : 'text-muted-foreground/60'}`} />
                    <span className="font-bold text-sm">{name}</span>
                    <span className={`text-xs font-semibold uppercase px-1.5 py-0.5 rounded ${
                        active ? 'bg-primary/10 text-primary' : 'bg-muted/40 text-muted-foreground/60'
                    }`}>{active ? 'Active' : 'Paused'}</span>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="ghost" size="icon" className="text-muted-foreground/60 hover:text-foreground">
                        <FlaskConical className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="text-muted-foreground/60 hover:text-foreground">
                        <Pencil className="h-4 w-4" />
                    </Button>
                    <div
                        onClick={() => setActive(v => !v)}
                        className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer ${active ? 'bg-primary' : 'bg-muted'}`}
                    >
                        <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${active && 'translate-x-4'}`} />
                    </div>
                </div>
            </div>
            <div className="space-y-2">
                {addons.map((addon, i) => (
                    <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-card/50">
                        <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground shrink-0">{i + 1}</div>
                        <span className="text-sm text-foreground flex-1">{addon}</span>
                        {i === 0 && <span className="text-xs font-bold uppercase px-1.5 py-0.5 rounded bg-primary/10 text-primary">Primary</span>}
                    </div>
                ))}
            </div>
            <p className="text-xs text-muted-foreground/60 text-center">Toggle the rule on and off using the switch</p>
        </div>
    )
}

export function DemoDiscordEmbed({ type = 'failover' }: { type?: 'failover' | 'recovery' }) {
    const [shown, setShown] = useState<'failover' | 'recovery'>(type)

    return (
        <div className="my-4 space-y-3">
            <div className="flex gap-2">
                {(['failover', 'recovery'] as const).map(t => (
                    <Button
                        key={t}
                        variant="ghost"
                        size="sm"
                        onClick={() => setShown(t)}
                        className={`text-xs px-3 py-1.5 rounded-full border font-medium ${
                            shown === t
                                ? t === 'failover' ? 'bg-destructive/10 border-destructive/30 text-destructive' : 'bg-success/10 border-success/30 text-success'
                                : 'bg-muted/30 border-border text-muted-foreground hover:bg-muted/60'
                        }`}
                    >
                        {t === 'failover' ? '⚠️ Failover' : '✅ Recovery'}
                    </Button>
                ))}
            </div>
            <div className="rounded-xl border border-border bg-[#313338] p-4 font-sans">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold">A</div>
                    <div>
                        <span className="text-white text-sm font-semibold">AIOManager Autopilot</span>
                        <span className="text-[#949ba4] text-xs ml-2">Today at 3:42 PM</span>
                    </div>
                </div>
                <div className={`border-l-4 rounded-r-lg p-3 space-y-2 ${
                    shown === 'failover' ? 'border-l-destructive bg-destructive/10' : 'border-l-success bg-success/10'
                }`}>
                    <div className="flex items-center gap-2">
                        <span className="text-white text-sm font-bold">
                            {shown === 'failover' ? '⚠️ Failover' : '✅ Recovery'}
                        </span>
                    </div>
                    <p className="text-[#dbdee1] text-xs">
                        {shown === 'failover'
                            ? 'Primary offline. Switched to backup.'
                            : 'Primary recovered. Restored original priority.'}
                    </p>
                    <div className="grid grid-cols-2 gap-2 pt-1">
                        <div>
                            <p className="text-[#b5bac1] text-xs font-bold uppercase">Account</p>
                            <p className="text-[#dbdee1] text-xs">a1b2c3d4</p>
                        </div>
                        <div>
                            <p className="text-[#b5bac1] text-xs font-bold uppercase">Active Addon</p>
                            <p className="text-[#dbdee1] text-xs font-mono text-xs">stream.backup.com/••••</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
