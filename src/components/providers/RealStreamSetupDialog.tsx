import { Button } from '@/components/ui/button'
import { motion } from 'framer-motion'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { realstreamAuth, realstreamSignup } from '@/api/hydra-providers'
import {
    Check,
    Loader2,
    AlertCircle,
    Mail,
    Lock,
} from 'lucide-react'
import { useState, useCallback, useRef } from 'react'
import { cn, maskEmailLevel } from '@/lib/utils'
import { useUIStore } from '@/store/uiStore'

type WizardStep = 'login' | 'confirm'

export interface RealStreamTokens {
    accessToken: string
    userId: string | null
    expiresAt: number
}

interface RealStreamSetupDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onComplete: (tokens: RealStreamTokens, email: string, password: string) => void | Promise<void>
    onBackToPicker?: () => void
}

const STEP_INDICATORS = [
    { step: 'login' as const, label: 'Login' },
    { step: 'confirm' as const, label: 'Confirm' },
]

export function RealStreamSetupDialog({ open, onOpenChange, onComplete, onBackToPicker }: RealStreamSetupDialogProps) {
    const [step, setStep] = useState<WizardStep>('login')
    const [mode, setMode] = useState<'login' | 'signup'>('login')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [tokens, setTokens] = useState<RealStreamTokens | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const requestGeneration = useRef(0)
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelEmail = useUIStore(s => s.privacyLevelEmail)
    const emailPrivacyLevel = isPrivacyModeEnabled ? privacyLevelEmail : 0

    const reset = useCallback(() => {
        requestGeneration.current += 1
        setStep('login')
        setMode('login')
        setEmail('')
        setPassword('')
        setLoading(false)
        setError(null)
        setTokens(null)
        setSubmitting(false)
    }, [])

    const handleClose = (nextOpen: boolean) => {
        if (!nextOpen) reset()
        onOpenChange(nextOpen)
    }

    const handleLogin = async () => {
        const generation = requestGeneration.current
        setLoading(true)
        setError(null)
        try {
            const result = mode === 'signup' ? await realstreamSignup(email, password) : await realstreamAuth(email, password)
            if (generation !== requestGeneration.current) return
            if (!result.tokens) {
                setMode('login')
                setError('Check your email to confirm your RealStream account, then sign in.')
                return
            }
            setTokens(result.tokens)
            setStep('confirm')
        } catch (err) {
            if (generation === requestGeneration.current) {
                setError(err instanceof Error ? err.message : 'Login failed')
            }
        } finally {
            if (generation === requestGeneration.current) setLoading(false)
        }
    }

    const handleFinish = async () => {
        if (!tokens || submitting) return
        const generation = requestGeneration.current
        setSubmitting(true)
        setError(null)
        try {
            await onComplete(tokens, email, password)
            if (generation === requestGeneration.current) handleClose(false)
        } catch (e) {
            if (generation === requestGeneration.current) {
                setError(e instanceof Error ? e.message : 'Failed to add connection')
            }
        } finally {
            if (generation === requestGeneration.current) setSubmitting(false)
        }
    }

    const stepIndex = STEP_INDICATORS.findIndex(s => s.step === step)
    const emailValid = email.includes('@')
    const passwordValid = password.length > 0

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Connect RealStream</DialogTitle>
                    <DialogDescription>
                        Sign in to your RealStream account to sync addons.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex items-center gap-2 mt-2">
                    {STEP_INDICATORS.map((s, i) => {
                        const active = s.step === step
                        const done = i < stepIndex
                        return (
                            <div key={s.step} className="flex items-center gap-2 flex-1">
                                <div
                                    className={cn(
                                        'flex items-center justify-center h-7 w-7 rounded-full text-xs font-bold shrink-0 transition-colors',
                                        active ? 'bg-primary text-primary-foreground' :
                                        done ? 'bg-success/20 text-success' :
                                        'bg-muted text-muted-foreground'
                                    )}
                                >
                                    {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                                </div>
                                <span className={cn(
                                    'text-xs font-medium truncate',
                                    active ? 'text-foreground' : 'text-muted-foreground'
                                )}>
                                    {s.label}
                                </span>
                                {i < STEP_INDICATORS.length - 1 && (
                                    <div className={cn(
                                        'flex-1 h-px',
                                        done ? 'bg-success/40' : 'bg-border'
                                    )} />
                                )}
                            </div>
                        )
                    })}
                </div>

                <div className="min-h-[200px]">
                    {step === 'login' && (
                        <div className="space-y-4 mt-2">
                            <div data-theme-part="tabs-list" className="grid grid-cols-2 gap-0.5 rounded-xl bg-muted/30 p-0.5 border border-border/40">
                                <button
                                    type="button"
                                    data-theme-part="tab"
                                    data-state={mode === 'login' ? 'active' : 'inactive'}
                                    onClick={() => { setMode('login'); setError(null) }}
                                    className={cn(
                                        'relative h-8 rounded-lg text-xs font-semibold transition-colors z-10',
                                        mode === 'login' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    {mode === 'login' && (
                                        <motion.div
                                            layoutId="rs-mode-active"
                                            data-theme-part="tab-indicator"
                                            className="absolute inset-0 bg-background rounded-lg shadow-sm -z-10 border border-border/10"
                                            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                                        />
                                    )}
                                    Sign In
                                </button>
                                <button
                                    type="button"
                                    data-theme-part="tab"
                                    data-state={mode === 'signup' ? 'active' : 'inactive'}
                                    onClick={() => { setMode('signup'); setError(null) }}
                                    className={cn(
                                        'relative h-8 rounded-lg text-xs font-semibold transition-colors z-10',
                                        mode === 'signup' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    {mode === 'signup' && (
                                        <motion.div
                                            layoutId="rs-mode-active"
                                            data-theme-part="tab-indicator"
                                            className="absolute inset-0 bg-background rounded-lg shadow-sm -z-10 border border-border/10"
                                            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                                        />
                                    )}
                                    Create Account
                                </button>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="realstream-email">Email</Label>
                                <div className="relative">
                                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        id="realstream-email"
                                        type="email"
                                        placeholder="you@example.com"
                                        value={email}
                                        onChange={e => setEmail(e.target.value)}
                                        className="pl-10"
                                        autoFocus
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="realstream-password">Password</Label>
                                <div className="relative">
                                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        id="realstream-password"
                                        type="password"
                                        placeholder="Your RealStream password"
                                        value={password}
                                        onChange={e => setPassword(e.target.value)}
                                        className="pl-10"
                                        onKeyDown={e => {
                                            if (e.key === 'Enter' && emailValid && passwordValid) handleLogin()
                                        }}
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {step === 'confirm' && (
                        <div className="space-y-4 mt-2">
                            <p className="text-sm text-muted-foreground">Review your RealStream connection before adding.</p>

                            <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card p-4 space-y-3">
                                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                                    <span className="text-muted-foreground">Account</span>
                                    <span className="font-medium truncate">{maskEmailLevel(email, emailPrivacyLevel)}</span>
                                </div>
                            </div>

                            <div data-theme-tone="status" data-theme-part="panel" className="rounded-xl bg-warning/10 border border-warning/20 px-3 py-2 text-xs text-warning flex items-start gap-2">
                                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                <span>Your credentials are stored encrypted on your sync server so the connection stays alive after the session token expires.</span>
                            </div>
                        </div>
                    )}
                </div>

                {error && (
                    <div role="alert" data-theme-tone="status" data-theme-part="panel" className="rounded-xl bg-destructive/5 border border-destructive/20 px-3 py-2 text-xs text-destructive flex items-center gap-2">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        {error}
                    </div>
                )}

                <DialogFooter>
                    {onBackToPicker && !loading && !submitting && <Button variant="outline" onClick={() => { reset(); onBackToPicker() }}>Back to connection picker</Button>}
                    {step !== 'login' && (
                        <Button
                            variant="subtle"
                            onClick={() => setStep('login')}
                            disabled={loading || submitting}
                        >
                            Back
                        </Button>
                    )}

                    <div className="flex-1" />

                    {step === 'login' && (
                        <>
                            <Button variant="subtle" onClick={() => handleClose(false)}>Cancel</Button>
                            <Button
                                onClick={handleLogin}
                                disabled={!emailValid || !passwordValid || loading}
                            >
                                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                                {loading ? (mode === 'signup' ? 'Creating...' : 'Signing in...') : (mode === 'signup' ? 'Create Account' : 'Sign In')}
                            </Button>
                        </>
                    )}

                    {step === 'confirm' && (
                        <Button onClick={handleFinish} disabled={submitting}>
                            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                            {submitting ? 'Adding...' : 'Add Connection'}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
