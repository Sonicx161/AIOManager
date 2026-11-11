import { Component, ErrorInfo, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle, RefreshCw, Home, LifeBuoy } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { copyTextToClipboard } from '@/components/ui/copy-button'
import { buildSupportCopyText } from '@/lib/support-info-gather'
import pkg from '../../../package.json'

interface Props {
    children: ReactNode
}

interface State {
    hasError: boolean
    error: Error | null
    errorInfo: ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
        errorInfo: null,
    }

    public static getDerivedStateFromError(error: Error): Partial<State> {
        return { hasError: true, error }
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Uncaught error:', error, errorInfo)
        this.setState({ errorInfo })
    }

    private handleCopySupport = () => {
        void (async () => {
            try {
                const { error, errorInfo } = this.state
                const componentNames = typeof errorInfo?.componentStack === 'string'
                    ? [...new Set([...errorInfo.componentStack.matchAll(/\bat\s+([A-Za-z][A-Za-z0-9_$]*)/g)].map(m => m[1]))]
                    : []
                const text = await buildSupportCopyText({
                    errorName: error?.name || 'Error',
                    message: error?.message || null,
                    stack: error?.stack || null,
                    components: componentNames,
                    route: window.location.pathname,
                })
                const ok = await copyTextToClipboard(text)
                if (ok) {
                    toast({ title: 'Support info copied', description: 'One redacted summary is on your clipboard. Check before sharing.' })
                } else {
                    toast({ variant: 'destructive', title: 'Copy unavailable', description: 'The clipboard is blocked on this connection (http). Select the text and copy it manually.' })
                }
            } catch (e) {
                if (import.meta.env.DEV) console.error('[ErrorBoundary] support info failed:', e)
                toast({ variant: 'destructive', title: 'Could not build support info', description: 'Try Reload app, then copy again.' })
            }
        })()
    }

    private handleReset = () => {
        // Direct browser navigation is safest during a UI crash
        window.location.href = '/'
    }

    private handleReload = () => {
        // Hard browser reload to clear memory and hung states
        window.location.reload()
    }

    public render() {
        if (this.state.hasError) {
            return (
                <div data-theme-part="app-shell" className="min-h-screen bg-background flex items-center justify-center p-4">
                    <section data-theme-part="panel"
                        className="max-w-lg w-full rounded-xl border border-border/40 bg-card p-6 text-center shadow-sm animate-in fade-in zoom-in-95 duration-300 sm:p-8"
                        aria-labelledby="error-boundary-title"
                    >
                        <div className="flex justify-center">
                            <div data-theme-part="badge" className="flex h-16 w-16 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10">
                                <AlertTriangle className="h-7 w-7 text-destructive" />
                            </div>
                        </div>

                        <div className="mt-6 space-y-3">
                            <p className="text-xs font-medium text-muted-foreground uppercase">Recovery</p>
                            <h1 id="error-boundary-title" className="text-2xl font-bold tracking-tight">
                                Something went wrong.
                            </h1>
                            <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                                AIOManager hit a UI crash. Your saved data remains intact; reload to retry.
                            </p>
                        </div>

                        {this.state.error && (
                            <div data-theme-part="field" className="mt-6 space-y-3 overflow-hidden rounded-lg border border-border/40 bg-muted/20 p-4 text-left">
                                <p className="text-xs font-medium text-muted-foreground uppercase">Error detail</p>
                                <p className="break-all font-mono text-xs leading-relaxed text-destructive">
                                    {this.state.error.message}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    The copy below includes this crash, sanitized, plus versions, device, recent sync errors and storage.
                                </p>
                            </div>
                        )}

                        <div className="mt-4 space-y-2">
                            <Button onClick={this.handleCopySupport} variant="outline" className="w-full h-11 rounded-full gap-2">
                                <LifeBuoy className="h-4 w-4" />
                                Copy support info
                            </Button>
                            <p className="text-xs text-muted-foreground">
                                One cleaned-up summary: app and server versions, browser and device, recent sync errors, unfinished uploads, storage. No ids, tokens or links.
                            </p>
                        </div>

                        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
                            <Button
                                onClick={this.handleReload}
                                className="w-full h-11 rounded-full gap-2 sm:w-auto"
                            >
                                <RefreshCw className="h-4 w-4" />
                                Reload app
                            </Button>
                            <Button
                                variant="outline"
                                onClick={this.handleReset}
                                className="w-full h-11 rounded-full gap-2 sm:w-auto"
                            >
                                <Home className="h-4 w-4" />
                                Return home
                            </Button>
                        </div>

                        <span className="mt-6 block text-xs text-muted-foreground">
                            AIOManager v{pkg.version}{(pkg as { build?: number }).build ? ` · Build ${(pkg as { build?: number }).build}` : ''}
                        </span>
                    </section>
                </div>
            )
        }

        return this.props.children
    }
}
