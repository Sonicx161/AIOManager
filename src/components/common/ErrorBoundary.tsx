import { Component, ErrorInfo, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle, RefreshCw, Home } from 'lucide-react'

interface Props {
    children: ReactNode
}

interface State {
    hasError: boolean
    error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
    }

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error }
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Uncaught error:', error, errorInfo)
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
                <div className="min-h-screen bg-background flex items-center justify-center p-4">
                    <div className="max-w-md w-full space-y-8 text-center animate-in fade-in zoom-in duration-500">
                        <div className="flex justify-center">
                            <div className="p-6 rounded-3xl bg-destructive/10 ring-1 ring-destructive/20 relative">
                                <AlertTriangle className="h-16 w-16 text-destructive animate-pulse" />
                                <div className="absolute inset-0 bg-destructive/5 blur-3xl rounded-full" />
                            </div>
                        </div>

                        <div className="space-y-3">
                            <h1 className="text-3xl font-black tracking-tight uppercase italic text-foreground">
                                Something went <span className="text-destructive">wrong</span>
                            </h1>
                            <p className="text-sm text-muted-foreground leading-relaxed">
                                The application encountered an unexpected error. Don't worry, your data is safe—this is just a UI crash.
                            </p>
                        </div>

                        {this.state.error && (
                            <div className="p-4 rounded-xl bg-muted/50 border border-border text-left overflow-hidden">
                                <p className="text-[10px] font-mono text-muted-foreground uppercase mb-2 tracking-widest">Error Detail</p>
                                <p className="text-xs font-mono text-destructive break-all leading-tight">
                                    {this.state.error.message}
                                </p>
                            </div>
                        )}

                        <div className="flex flex-col gap-3">
                            <Button
                                onClick={this.handleReload}
                                className="w-full bg-primary hover:bg-primary/90 text-white font-black uppercase italic tracking-widest h-12 rounded-xl group group/btn shadow-lg shadow-primary/20"
                            >
                                <RefreshCw className="mr-2 h-4 w-4 transition-transform group-active:rotate-180" />
                                Reload Application
                            </Button>
                            <Button
                                variant="outline"
                                onClick={this.handleReset}
                                className="w-full border-primary/20 hover:bg-primary/5 font-black uppercase italic tracking-widest h-12 rounded-xl"
                            >
                                <Home className="mr-2 h-4 w-4" />
                                Return Home
                            </Button>
                        </div>

                        <p className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground opacity-30 italic">
                            AIOManager v1.8.0 Recovery System
                        </p>
                    </div>
                </div>
            )
        }

        return this.props.children
    }
}
