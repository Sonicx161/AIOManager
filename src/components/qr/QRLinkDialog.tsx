import * as React from 'react'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { computeQrPhase, nextPollDelay, type QRPollOutcome, type QRSession } from '@/lib/qr-device-link'
import { trace } from '@/lib/trace'
import { AlertCircle, Loader2, RefreshCw, X } from 'lucide-react'

interface QRLinkDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    description?: string
    start: () => Promise<QRSession>
    poll: (session: QRSession) => Promise<QRPollOutcome>
    onClaimed: (session: QRSession) => void | Promise<void>
    pollIntervalMs?: number
}

type DialogPhase = 'starting' | 'active' | 'expired' | 'error' | 'claimed'

export function QRLinkDialog({
    open,
    onOpenChange,
    title,
    description,
    start,
    poll,
    onClaimed,
    pollIntervalMs,
}: QRLinkDialogProps) {
    const [phase, setPhase] = React.useState<DialogPhase>('starting')
    const [session, setSession] = React.useState<QRSession | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const [now, setNow] = React.useState(() => Date.now())
    const runRef = React.useRef(0)
    const phaseRef = React.useRef(phase)
    // Latest-callback refs: parents pass inline closures, so effect deps must never see these identities.
    const startRef = React.useRef(start)
    const pollRef = React.useRef(poll)
    const onClaimedRef = React.useRef(onClaimed)
    const onOpenChangeRef = React.useRef(onOpenChange)

    React.useEffect(() => {
        phaseRef.current = phase
    }, [phase])

    React.useEffect(() => {
        startRef.current = start
        pollRef.current = poll
        onClaimedRef.current = onClaimed
        onOpenChangeRef.current = onOpenChange
    })

    const beginSession = React.useCallback(async () => {
        const run = ++runRef.current
        setPhase('starting')
        setError(null)
        setSession(null)
        try {
            const next = await startRef.current()
            if (run !== runRef.current) return
            setSession(next)
            setNow(Date.now())
            setPhase('active')
        } catch (err) {
            if (run !== runRef.current) return
            setError(err instanceof Error ? err.message : 'Failed to generate QR code')
            setPhase('error')
        }
    }, [])

    const completeClaim = React.useCallback(async (claimed: QRSession) => {
        const run = runRef.current
        setPhase('claimed')
        await Promise.resolve(onClaimedRef.current(claimed)).catch(err => {
            trace('qrLinkDialog', 'claim.error', { error: err instanceof Error ? err.message : String(err) })
        })
        if (run !== runRef.current) return
        onOpenChangeRef.current(false)
    }, [])

    React.useEffect(() => {
        if (!open) {
            runRef.current++
            setSession(null)
            setError(null)
            setPhase('starting')
            return
        }
        void beginSession()
    }, [open, beginSession])

    React.useEffect(() => {
        if (!open || phase !== 'active' || !session) return
        let attempt = 0
        let timer: ReturnType<typeof setTimeout> | undefined
        let cancelled = false
        const intervalMs = session.pollIntervalMs ?? pollIntervalMs ?? 3000
        const pollOnce = async () => {
            let outcome: QRPollOutcome
            try {
                outcome = await pollRef.current(session)
            } catch {
                outcome = 'pending'
            }
            if (cancelled) return
            if (outcome === 'claimed') {
                void completeClaim(session)
                return
            }
            if (outcome === 'expired') {
                setPhase('expired')
                return
            }
            timer = setTimeout(pollOnce, nextPollDelay(attempt++, intervalMs))
        }
        timer = setTimeout(pollOnce, intervalMs)
        return () => {
            cancelled = true
            if (timer !== undefined) clearTimeout(timer)
        }
    }, [open, phase, session, pollIntervalMs, completeClaim])

    React.useEffect(() => {
        if (!open || phase !== 'active' || !session) return
        const id = setInterval(() => {
            const t = Date.now()
            setNow(t)
            if (computeQrPhase(session, t) === 'expired') setPhase('expired')
        }, 1000)
        return () => clearInterval(id)
    }, [open, phase, session])

    const requestClose = React.useCallback(() => {
        if (phaseRef.current === 'claimed') return
        runRef.current++
        onOpenChange(false)
    }, [onOpenChange])

    const handleOpenChange = React.useCallback((next: boolean) => {
        if (!next && phaseRef.current === 'claimed') return
        if (!next) runRef.current++
        onOpenChange(next)
    }, [onOpenChange])

    const timeLeft = React.useMemo(() => {
        if (!session) return null
        const diff = Math.max(0, session.expiresAt - now)
        const minutes = Math.floor(diff / 60000)
        const seconds = Math.floor((diff % 60000) / 1000)
        return `${minutes}:${seconds.toString().padStart(2, '0')}`
    }, [session, now])

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent hideClose className="max-w-md gap-0 overflow-hidden p-0">
                <DialogHeader className="items-center px-6 pb-2 pt-7 text-center">
                    <DialogTitle className="text-xl tracking-tight">{title}</DialogTitle>
                    {description && (
                        <DialogDescription className="max-w-sm text-pretty text-sm leading-6">
                            {description}
                        </DialogDescription>
                    )}
                </DialogHeader>
                <div className="px-6 pb-6">
                    {phase === 'starting' && (
                        <div className="flex flex-col items-center gap-3 py-10">
                            <Loader2 className="h-6 w-6 animate-spin text-primary" />
                            <p className="text-sm text-muted-foreground">Generating QR code...</p>
                        </div>
                    )}
                    {phase === 'error' && (
                        <div className="space-y-4">
                            <div data-theme-tone="status" data-theme-part="panel" className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
                                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                <p>{error}</p>
                            </div>
                            <Button variant="outline" className="w-full gap-2" onClick={() => void beginSession()}>
                                <RefreshCw className="h-4 w-4" />
                                Retry
                            </Button>
                        </div>
                    )}
                    {phase === 'expired' && (
                        <div className="space-y-4">
                            <div data-theme-tone="status" data-theme-part="panel" className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 p-3 text-xs text-warning">
                                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                <p>This code expired before it was approved. Generate a new one to continue.</p>
                            </div>
                            <Button variant="outline" className="w-full gap-2" onClick={() => void beginSession()}>
                                <RefreshCw className="h-4 w-4" />
                                Generate new code
                            </Button>
                        </div>
                    )}
                    {phase === 'claimed' && (
                        <div className="flex flex-col items-center gap-3 py-10">
                            <Loader2 className="h-6 w-6 animate-spin text-success" />
                            <p className="text-sm font-medium">Approved</p>
                        </div>
                    )}
                    {phase === 'active' && session && (
                        <div className="flex flex-col items-center gap-4">
                            <div className="rounded-2xl border border-border/40 bg-white p-3 shadow-sm">
                                <img src={session.qrImage} alt="Login QR code" className="h-48 w-48" />
                            </div>
                            <p className="max-w-full break-all px-2 text-center font-mono text-lg font-bold tracking-[0.2em]">{session.code}</p>
                            <div data-theme-part="field" className="flex w-full items-start gap-2 rounded-xl border border-border/40 bg-muted/30 px-3 py-2">
                                <span className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed text-muted-foreground">
                                    {session.link}
                                </span>
                                <CopyButton value={session.link} variant="ghost" iconSize={14} />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Expires in{' '}
                                <span className="font-mono font-medium tabular-nums text-foreground">{timeLeft}</span>
                            </p>
                            <div className="flex items-center gap-2 pt-1">
                                <Loader2 className="h-3 w-3 animate-spin text-primary" />
                                <span className="text-xs italic text-muted-foreground">Waiting for approval...</span>
                            </div>
                        </div>
                    )}
                </div>
                <button data-theme-part="button"
                    type="button"
                    onClick={requestClose}
                    aria-label="Close dialog"
                    className="absolute right-4 top-4 flex items-center justify-center rounded-full bg-muted/30 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                    <X className="h-3.5 w-3.5" />
                    <span className="sr-only">Close</span>
                </button>
            </DialogContent>
        </Dialog>
    )
}
