import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, ExternalLink, Copy, CheckCircle2, AlertCircle } from 'lucide-react'

interface StremioOAuthProps {
    onAuthKey: (authKey: string, user?: { email?: string; username?: string; name?: string }) => void
    onError?: (message: string) => void
    disabled?: boolean
}

export function StremioOAuth({ onAuthKey, onError, disabled }: StremioOAuthProps) {
    const [isCreating, setIsCreating] = useState(false)
    const [isPolling, setIsPolling] = useState(false)
    const [stremioLink, setStremioLink] = useState<string | null>(null)
    const [stremioCode, setStremioCode] = useState('')
    const [expiresAt, setExpiresAt] = useState<number | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [tick, setTick] = useState(0)
    const [isCopied, setIsCopied] = useState(false)
    const [isLinkCopied, setIsLinkCopied] = useState(false)

    const isExpired = expiresAt ? Date.now() > expiresAt : false

    const timeLeft = (() => {
        // We reference tick to ensure we re-calculate every second
        // but we don't need its value, just the re-render it triggers
        void tick;
        if (!expiresAt || isExpired) return null
        const diff = Math.max(0, expiresAt - Date.now())
        const minutes = Math.floor(diff / 60000)
        const seconds = Math.floor((diff % 60000) / 1000)
        return `${minutes}:${seconds.toString().padStart(2, '0')}`
    })()

    const startOAuthFlow = useCallback(async () => {
        if (isCreating || disabled) return
        setIsCreating(true)
        setError(null)
        setStremioLink(null)
        setStremioCode('')
        setExpiresAt(null)
        setIsPolling(false)

        try {
            const host = window.location.host
            const origin = window.location.origin

            const res = await fetch('https://link.stremio.com/api/v2/create?type=Create', {
                headers: {
                    'X-Requested-With': host,
                    Origin: origin,
                },
                referrerPolicy: 'no-referrer',
            })

            if (!res.ok) throw new Error('Failed to connect to Stremio')

            const data = await res.json()
            if (data?.result?.success && data?.result?.code && data?.result?.link) {
                setStremioLink(data.result.link)
                setStremioCode(data.result.code)
                setExpiresAt(Date.now() + 5 * 60 * 1000) // 5 minutes
                setIsPolling(true)
            } else {
                throw new Error(data?.error?.message || 'Failed to generate link')
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Login failed'
            setError(msg)
            if (onError) onError(msg)
        } finally {
            setIsCreating(false)
        }
    }, [disabled, isCreating, onError])

    useEffect(() => {
        if (!isPolling || !stremioCode || disabled) return

        let cancelled = false
        const poll = async () => {
            if (cancelled || isExpired) return

            try {
                const host = window.location.host
                const origin = window.location.origin
                const res = await fetch(
                    `https://link.stremio.com/api/v2/read?type=Read&code=${encodeURIComponent(stremioCode)}`,
                    {
                        headers: {
                            'X-Requested-With': host,
                            Origin: origin,
                        },
                        referrerPolicy: 'no-referrer',
                    }
                )
                if (cancelled) return

                if (res.status === 410) {
                    setError('Link expired. Please try again.')
                    setIsPolling(false)
                    return
                }

                if (!res.ok) {
                    throw new Error(`Server returned ${res.status}`)
                }

                const data = await res.json()
                if (cancelled) return
                if (data?.result?.success && data.result.authKey) {
                    onAuthKey(data.result.authKey, data.result.user)
                    setIsPolling(false)
                } else if (data?.error) {
                    const code = data.error.code
                    if (code === 101) return
                    if (code === 404 || code === 410 || data.error.message?.toLowerCase().includes('expired')) {
                        setError('Link expired or invalidated. Please try again.')
                        setIsPolling(false)
                        return
                    }
                    throw new Error(data.error.message || 'Polling failed')
                }
            } catch (err) {
                if (!cancelled && import.meta.env.DEV) console.warn('Stremio OAuth Poll Error:', err)
            }
        }

        const interval = setInterval(poll, 3000)
        return () => {
            cancelled = true
            clearInterval(interval)
        }
    }, [isPolling, stremioCode, isExpired, onAuthKey, disabled])

    useEffect(() => {
        if (!expiresAt || isExpired) return
        const interval = setInterval(() => setTick((t) => t + 1), 1000)
        return () => clearInterval(interval)
    }, [expiresAt, isExpired])

    const copyCode = () => {
        if (!stremioCode) return
        try {
            navigator.clipboard.writeText(stremioCode)
            setIsCopied(true)
            setTimeout(() => setIsCopied(false), 2000)
        } catch {
            setIsCopied(false)
        }
    }

    return (
        <div className="space-y-4 pt-2">
            {!stremioLink ? (
                <div data-theme-part="panel" className="flex flex-col items-center justify-center p-8 border border-dashed rounded-lg bg-muted/30">
                    <div className="mb-4 p-3 rounded-full bg-primary/10">
                        <ExternalLink className="h-6 w-6 text-primary" />
                    </div>
                    <h3 className="font-semibold text-sm mb-1">Stremio OAuth</h3>
                    <p className="text-xs text-muted-foreground text-center mb-6 max-w-[240px]">
                        Approve Stremio's official link flow. No password is shared with AIOManager.
                    </p>
                    <div data-theme-tone="status" data-theme-part="panel" className="mb-4 rounded-md border border-warning/25 bg-warning/10 p-3 text-left text-xs text-warning">
                        <p className="font-medium">May expire after Stremio Web logout</p>
                        <p className="mt-1 text-warning/85">
                            Stremio can revoke OAuth link tokens when the approving web session signs out. After approval, add your password for long-lived sync.
                        </p>
                    </div>
                    <Button
                        type="button"
                        onClick={startOAuthFlow}
                        disabled={isCreating || disabled}
                        className="w-full gap-2"
                    >
                        {isCreating ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Connecting...
                            </>
                        ) : (
                            'Generate Login Link'
                        )}
                    </Button>
                </div>
            ) : (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                    {error && (
                        <div data-theme-tone="status" data-theme-part="panel" className="p-3 rounded-md bg-destructive/10 border border-destructive/20 flex items-start gap-2 text-xs text-destructive">
                            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                            <p>{error}</p>
                        </div>
                    )}

                    <div data-theme-part="panel" className="p-4 rounded-lg bg-primary/5 border border-primary/10 flex flex-col items-center gap-4">
                        <div className="text-center space-y-1">
                            <p className="text-sm font-medium">Authorization Code</p>
                            <div
                                onClick={copyCode}
                                className="cursor-pointer group relative flex items-center justify-center gap-3 bg-background border px-6 py-3 rounded-xl hover:border-primary/50 transition-[transform,opacity,box-shadow] active:scale-95"
                            >
                                <span className="text-2xl font-mono font-bold">{stremioCode}</span>
                                {isCopied ? (
                                    <CheckCircle2 className="h-4 w-4 text-success" />
                                ) : (
                                    <Copy className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                                )}
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2 w-full">
                            <Button
                                type="button"
                                variant="subtle"
                                 className="bg-background gap-2"
                                onClick={() => { if (stremioLink) window.open(stremioLink, '_blank', 'noopener,noreferrer') }}
                                >
                                    <ExternalLink className="h-4 w-4" />
                                Open Link
                            </Button>
                            <Button
                                type="button"
                                variant="subtle"
                                 className="bg-background gap-2"
                                onClick={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    if (stremioLink) {
                                        try {
                                            navigator.clipboard.writeText(stremioLink)
                                            setIsLinkCopied(true)
                                            setTimeout(() => setIsLinkCopied(false), 2000)
                                        } catch (e) { if (import.meta.env.DEV) console.error(e) }
                                    }
                                }}
                            >
                                 {isLinkCopied ? (
                                    <CheckCircle2 className="h-4 w-4 text-success" />
                                 ) : (
                                    <Copy className="h-4 w-4" />
                                )}
                                {isLinkCopied ? 'Copied' : 'Copy Link'}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground text-center">
                            Link expires in <span className="font-mono font-medium text-foreground">{timeLeft}</span>
                        </p>
                    </div>

                    <div className="flex flex-col items-center gap-2 py-2">
                        <div className="flex items-center gap-2">
                            <Loader2 className="h-3 w-3 animate-spin text-primary" />
                            <span className="text-xs text-muted-foreground italic">
                                Waiting for you to authorize...
                            </span>
                        </div>
                        <button
                            type="button"
                            data-theme-part="button"
                            onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                startOAuthFlow()
                            }}
                            className="text-xs text-primary hover:underline"
                        >
                            Link expired? Generate new one
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
