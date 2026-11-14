import { Suspense, useState, useEffect, useRef } from 'react'
import { useSyncStore } from '@/store/syncStore'
import { captureSyncOwnership, syncRuntime, type SyncOwnership } from '@/store/sync-store-helpers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Rocket, Lock, Key, LogIn, RefreshCw, Eye, EyeOff, ShieldAlert, UserRound, Fingerprint } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { useTheme } from '@/contexts/ThemeContext'
import { BrandLogo } from '@/components/common/BrandLogo'
import { lazyChunk } from '@/lib/lazy-chunk'
import { useAuthStore } from '@/store/authStore'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { clearLocalAuthSecrets, restoreLocalAuthSecrets } from '@/lib/crypto'
import { apiGet } from '@/lib/http-client'
import { endSessionAuthKey } from '@/lib/session-sync-token'
import {
    deactivateDeviceAuth,
    enrollRememberedDevice,
    requestSessionAuthKey,
    getRememberedGateInfo,
    unlockWithDevice,
    type RememberedGateInfo,
} from '@/lib/device-session'

import { CopyButton } from '@/components/ui/copy-button'
import { useConfetti } from '@/components/ui/confetti'
import { BorderBeam } from '@/components/ui/border-beam'
import { TypingText } from '@/components/ui/typing-text'
import { useDocumentTitle } from '@/hooks/use-document-title'
import pkg from '../../package.json'

interface LoginPageProps {
    initialMode?: 'login' | 'register'
}

const DashboardEntry = lazyChunk(() => import('@/components/common/DashboardEntry').then(m => ({ default: m.DashboardEntry })))

// A failed login can restore its prior workspace while retaining the same generation.
const isSupersededAuthFailure = (e: unknown, attempt: number, latest: number, ownership?: SyncOwnership) =>
    attempt !== latest || (e as Error)?.name === 'SyncOwnershipLostError' ||
    (ownership?.current() === false && ownership.seq !== syncRuntime.pullSeq && ownership.seq !== syncRuntime.adoptedSeq)

export function LoginPage({ initialMode = 'login' }: LoginPageProps = {}) {
    useDocumentTitle('Login')
    const auth = useSyncStore(s => s.auth)
    const register = useSyncStore(s => s.register)
    const login = useSyncStore(s => s.login)
    const logout = useSyncStore(s => s.logout)
    const { isLocked, unlock } = useAuthStore()
    const { logoUrl } = useTheme()

    const confetti = useConfetti()
    const [searchParams] = useSearchParams()
    const navigate = useNavigate()

    // Only the latest UI attempt may publish its outcome.
    const authAttemptSeq = useRef(0)

    const [mode, setMode] = useState<'login' | 'register'>(initialMode)
    const [showPassword, setShowPassword] = useState(false)
    const [customHtml, setCustomHtml] = useState<string | null>(null)
    const [isUnlocking, setIsUnlocking] = useState(false)
    const [showSwitchConfirm, setShowSwitchConfirm] = useState(false)
    const [showRegSuccess, setShowRegSuccess] = useState(false)
    const [registeredId, setRegisteredId] = useState('')
    const [hasCopied, setHasCopied] = useState(false)

    const [loginId, setLoginId] = useState(auth.id || '')
    const [loginPass, setLoginPass] = useState('')

    const [remember, setRemember] = useState(false)
    const [unlockFailures, setUnlockFailures] = useState(0)
    const [gateInfo, setGateInfo] = useState<RememberedGateInfo | null | undefined>(undefined)
    const [deviceBusy, setDeviceBusy] = useState(false)

    const knownDeviceLogin = !!(isLocked && auth.isAuthenticated && gateInfo && gateInfo.accountUUID === auth.id)

    const [regPass, setRegPass] = useState('')
    const [regPassConfirm, setRegPassConfirm] = useState('')
    const [isRegistering, setIsRegistering] = useState(false)

    const [loading, setLoading] = useState(false)
    const [loginError, setLoginError] = useState<string | null>(null)
    const [regError, setRegError] = useState<string | null>(null)
    const [registrationsClosed, setRegistrationsClosed] = useState(false)

    const passwordsMatch = regPass === regPassConfirm || !regPassConfirm
    const normalizedLoginError = loginError?.toLowerCase() ?? ''
    const notFoundError = normalizedLoginError.includes('not found')
    const sessionRestoreError = loginError ? /database is locked|vault is locked|session expired|app is not initialized|encryption metadata|unlock (?:the )?app/i.test(loginError) : false
    const passwordError = loginError ? /password|decrypt/i.test(loginError) && !sessionRestoreError : false

    useEffect(() => {
        apiGet<{ customHtml?: string; registrationsClosed?: boolean }>('/config')
            .then(data => {
                if (data?.customHtml) setCustomHtml(data.customHtml)
                setRegistrationsClosed(Boolean(data?.registrationsClosed))
            })
            .catch(() => {})
    }, [])

    useEffect(() => {
        if (registrationsClosed && mode === 'register') {
            setMode('login')
        }
    }, [registrationsClosed, mode])

    useEffect(() => {
        const idParam = searchParams.get('id')
        if (idParam) {
            setLoginId(idParam)
            setMode('login')
            toast({ title: "Account detected", description: "Enter your password to sign in." })
        }
    }, [searchParams])

    useEffect(() => {
        let cancelled = false
        getRememberedGateInfo().then(info => {
            if (!cancelled) setGateInfo(info)
        }).catch(() => {
            if (!cancelled) setGateInfo(null)
        })
        return () => { cancelled = true }
    }, [])

    const handleContinueWithDevice = async () => {
        const attempt = ++authAttemptSeq.current
        setLoading(false)
        setIsUnlocking(false)
        setDeviceBusy(true)
        try {
            const result = await unlockWithDevice()
            if (attempt !== authAttemptSeq.current) return
            if (result.ok) {
                toast({ title: "Welcome back", description: "Signed in with your saved sign-in." })
            } else if (result.reason === 'prf-cancelled' || result.reason === 'unavailable') {
                toast({ title: result.reason === 'prf-cancelled' ? "Passkey unlock cancelled" : "Could not reach the server", description: result.message })
            } else {
                toast({ title: "Sign in to continue", description: result.message })
            }
        } catch {
            if (attempt !== authAttemptSeq.current) return
            toast({ variant: "destructive", title: "Sign-in failed", description: "Something went wrong. Use the sign-in form below." })
        } finally {
            if (attempt === authAttemptSeq.current) setDeviceBusy(false)
        }
    }

    const handleRegister = async () => {
        if (!regPass) {
            toast({ variant: "destructive", title: "Password required", description: "Choose a password." })
            return
        }

        if (regPass.length < 8) {
            toast({ variant: "destructive", title: "Password too short", description: "Use at least 8 characters so your session can be restored reliably." })
            return
        }

        if (regPass !== regPassConfirm) {
            toast({ variant: "destructive", title: "Passwords do not match", description: "Enter the same password twice." })
            return
        }

        setIsRegistering(true)
        setRegError(null)
        try {
            await register(regPass)
            const newId = useSyncStore.getState().auth.id
            setRegisteredId(newId)
            setShowRegSuccess(true)
            confetti.fire({ particleCount: 80, spread: 70, origin: { x: 0.5, y: 0.4 } })
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Registration failed. Please try again.'
            if (msg.includes('Registrations are closed')) {
                setRegError('Registrations are closed on this instance.')
            } else {
                setRegError(msg)
            }
        } finally {
            setIsRegistering(false)
        }
    }

    const maybeRememberDevice = () => {
        if (!remember) {
            void requestSessionAuthKey()
            return
        }
        void (async () => {
            try {
                const enrolled = await enrollRememberedDevice()
                if (!enrolled) {
                    toast({ title: "Remembered sign-in unavailable", description: "This server does not support remembering this device yet. You are signed in as usual." })
                } else {
                    getRememberedGateInfo().then(info => setGateInfo(info)).catch(() => {})
                }
            } catch (e) {
                if (import.meta.env.DEV) console.error('[Auth] Remember-this-device enrollment failed:', e)
                toast({ title: "Remembered sign-in unavailable", description: "This device could not be remembered. You are signed in as usual." })
            }
        })()
    }

    const handleUnlock = async () => {
        if (!loginPass) {
            toast({ variant: "destructive", title: "Password required", description: "Enter your master password." })
            return
        }

        // Explicit password auth outranks the remembered layer: a stale device session
        // must never rewrite or gate these requests.
        deactivateDeviceAuth()
        endSessionAuthKey()
        const attempt = ++authAttemptSeq.current
        let ownership = captureSyncOwnership()
        setLoading(false)
        setDeviceBusy(false)
        setIsUnlocking(true)
        setLoginError(null)

        try {
            const success = await unlock(loginPass)
            if (attempt !== authAttemptSeq.current || !ownership.current()) return
            if (!success) {
                setUnlockFailures(n => n + 1)
                setLoginError('Invalid password')
            } else {
                setUnlockFailures(0)
                if (auth.id) {
                    useSyncStore.setState(s => ({ auth: { ...s.auth, password: loginPass, isAuthenticated: true } }))
                    // Local unlock restores IndexedDB only - deferred pull so the identity and avatar land like a normal login.
                    setTimeout(() => {
                        if (attempt === authAttemptSeq.current && ownership.current()) useSyncStore.getState().refreshFromCloud()
                    }, 1500)
                }
                void maybeRememberDevice()
                toast({ title: "Welcome back", description: "Signed in successfully." })
            }
        } catch (e) {
            if (isSupersededAuthFailure(e, attempt, authAttemptSeq.current, ownership)) return
            const msg = (e as Error).message

            if (msg.includes('not initialized')) {
                if (import.meta.env.DEV) console.log('[Auth] Local DB empty. Attempting Cloud Restore...')
                try {
                    const pending = login(auth.id, loginPass, true)
                    ownership = captureSyncOwnership()
                    await pending
                    if (attempt !== authAttemptSeq.current || !ownership.current()) return
                    void maybeRememberDevice()
                    toast({ title: "Restored", description: "Session restored from cloud." })
                } catch (restoreErr) {
                    if (import.meta.env.DEV) console.error('[Auth] Cloud restore failed:', restoreErr)
                    if (isSupersededAuthFailure(restoreErr, attempt, authAttemptSeq.current, ownership)) return
                    setLoginError("This browser session could not be restored. Log in from your original browser to sync first.")
                }
            } else {
                setLoginError(msg)
                if (import.meta.env.DEV) console.error("Unlock error:", e)
            }
        } finally {
            if (attempt === authAttemptSeq.current) setIsUnlocking(false)
        }
    }

    const handleLogin = async () => {
        if (!loginId || !loginPass) {
            toast({ variant: "destructive", title: "Missing credentials", description: "Enter your UUID and password." })
            return
        }

        // Explicit password auth outranks the remembered layer: a stale device session
        // must never rewrite or gate these requests.
        deactivateDeviceAuth()
        endSessionAuthKey()
        const attempt = ++authAttemptSeq.current
        let ownership = captureSyncOwnership()
        setIsUnlocking(false)
        setDeviceBusy(false)
        setLoading(true)
        setLoginError(null)
        try {
            const pending = login(loginId, loginPass)
            ownership = captureSyncOwnership()
            await pending
            if (attempt !== authAttemptSeq.current || !ownership.current()) return
            if (!useSyncStore.getState().auth.isAuthenticated) return
            void maybeRememberDevice()
        } catch (e) {
            if (import.meta.env.DEV) console.error("Login error:", e)
            if (isSupersededAuthFailure(e, attempt, authAttemptSeq.current, ownership)) return
            setLoginError((e as Error).message)
        } finally {
            if (attempt === authAttemptSeq.current) setLoading(false)
        }
    }

    const handleCloudRecoveryLogin = async () => {
        const effectiveId = loginId || auth.id
        if (!effectiveId || !loginPass) {
            toast({ variant: "destructive", title: "Missing credentials", description: "Enter your UUID and password." })
            return
        }

        const attempt = ++authAttemptSeq.current
        let ownership = captureSyncOwnership()
        setIsUnlocking(false)
        setDeviceBusy(false)
        setLoading(true)
        setLoginError(null)
        const localAuthBackup = clearLocalAuthSecrets()
        try {
            const pending = login(effectiveId, loginPass, false, true)
            ownership = captureSyncOwnership()
            await pending
            if (attempt !== authAttemptSeq.current || !ownership.current()) return
            if (!useSyncStore.getState().auth.isAuthenticated) return
            void maybeRememberDevice()
            toast({ title: "Signed in", description: "This browser session was reset and your cloud data was restored." })
        } catch (e) {
            console.error("Cloud recovery login error:", e)
            if (isSupersededAuthFailure(e, attempt, authAttemptSeq.current, ownership)) return
            restoreLocalAuthSecrets(localAuthBackup)
            const msg = (e as Error).message
            if (msg.includes("Encryption metadata") || msg.includes("Encryption Mismatch")) {
                setLoginError("Could not decrypt your cloud data with this password. Make sure you are using the correct UUID and password from when you registered.")
            } else {
                setLoginError(msg)
            }
        } finally {
            if (attempt === authAttemptSeq.current) setLoading(false)
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4 animate-in fade-in duration-500">
            <div className="max-w-md w-full space-y-5">
                {customHtml && (
                    <div
                        className="custom-html-container"
                        dangerouslySetInnerHTML={{ __html: customHtml }}
                    />
                )}

                <div className="text-center space-y-4">
                    <div className="flex justify-center">
                        <div className="flex h-20 w-20 items-center justify-center">
                            <BrandLogo logoUrl={logoUrl} className="h-20 w-20 text-foreground" />
                        </div>
                    </div>
                    <div className="space-y-1">
                        <h1 className="text-3xl font-bold tracking-tighter">AIOManager</h1>
                        <div className="text-sm text-muted-foreground">
                            <TypingText text="One manager to rule them all." delay={40} hideCursorOnComplete grow />
                        </div>
                    </div>
                </div>

                {!window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && (
                    <div data-theme-tone="status" data-theme-part="panel" className="bg-destructive/10 border border-destructive/20 p-4 rounded-lg space-y-2 animate-in slide-in-from-top-2 duration-500">
                        <div className="flex items-center gap-2 text-sm text-destructive font-semibold">
                            <ShieldAlert className="h-5 w-5" />
                            <span>Secure connection required</span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                            AIOManager needs HTTPS for browser encryption and sync APIs. Use a reverse proxy or access it from <code>localhost</code>.
                        </p>
                        <div className="pt-1">
                            <a
                                href="https://github.com/Sonicx161/AIOManager#secure-context-https-required"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-destructive/80 hover:text-destructive underline flex items-center gap-1"
                            >
                                Open setup guide
                            </a>
                        </div>
                    </div>
                )}

                <Tabs value={mode} onValueChange={(v) => { setMode(v as 'login' | 'register'); setShowPassword(false); }} className="w-full">
                    {!registrationsClosed && (
                        <TabsList className="mb-4 grid w-full grid-cols-2">
                            <TabsTrigger value="login" className="h-8">Login</TabsTrigger>
                            <TabsTrigger value="register" className="h-8">New Account</TabsTrigger>
                        </TabsList>
                    )}

                    <TabsContent value="register">
                        <Card className="relative overflow-hidden border border-border/60 bg-card shadow-sm">
                            <BorderBeam duration={14} />
                            <CardHeader>
                                <CardTitle className="text-lg font-bold tracking-tight">Create account</CardTitle>
                                <CardDescription>Generate a private UUID for your encrypted workspace.</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="space-y-2">
                                    <Label className="text-xs font-medium text-muted-foreground uppercase">Account UUID</Label>
                                    <div data-theme-part="panel" className="p-3 bg-muted/20 rounded-lg border border-border/40 text-center">
                                        <p className="text-xs text-muted-foreground">
                                            A unique UUID will be generated automatically.
                                        </p>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-xs font-medium text-muted-foreground uppercase">Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                            type={showPassword ? "text" : "password"}
                                            placeholder="••••••••"
                                            className={`h-11 pl-10 pr-12 ${regPass && regPass.length < 8 ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                                            autoComplete="new-password"
                                            value={regPass}
                                            onChange={(e) => setRegPass(e.target.value)}
                                        />
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="absolute right-0 top-0 h-11 w-11 text-muted-foreground hover:text-foreground"
                                            onClick={() => setShowPassword(!showPassword)}
                                            aria-label={showPassword ? "Hide password" : "Show password"}
                                        >
                                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </Button>
                                    </div>
                                    {regPass && regPass.length < 8 && (
                                        <p className="text-xs text-destructive mt-1">At least 8 characters required ({regPass.length}/8)</p>
                                    )}
                                </div>

                                <div className="space-y-2">
                                    <Label className="text-xs font-medium text-muted-foreground uppercase">Confirm password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                            type={showPassword ? "text" : "password"}
                                            placeholder="••••••••"
                                            className={`h-11 pl-10 pr-12 ${!passwordsMatch ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                                            autoComplete="new-password"
                                            value={regPassConfirm}
                                            onChange={(e) => setRegPassConfirm(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
                                        />
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="absolute right-0 top-0 h-11 w-11 text-muted-foreground hover:text-foreground"
                                            onClick={() => setShowPassword(!showPassword)}
                                            aria-label={showPassword ? "Hide password" : "Show password"}
                                        >
                                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </Button>
                                    </div>
                                    {!passwordsMatch && (
                                        <p className="text-xs text-destructive font-medium animate-in slide-in-from-top-1">
                                            Passwords do not match
                                        </p>
                                    )}
                                    <p className="text-xs text-muted-foreground pt-1">
                                        This password is the <strong>only key</strong> to your data. Do not lose it.
                                    </p>
                                </div>
                            </CardContent>
                            <CardFooter>
                                <Button className="w-full gap-2" size="xl" onClick={handleRegister} disabled={isRegistering || (regPass.length > 0 && regPass.length < 8) || !passwordsMatch}>
                                    {isRegistering ? (
                                        <RefreshCw className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Rocket className="h-4 w-4" />
                                    )}
                                    {isRegistering ? 'Creating account' : 'Create account'}
                                </Button>
                            </CardFooter>
                            {regError && (
                                <div className="px-6 pb-4">
                                    <p className="text-xs text-destructive font-medium animate-in slide-in-from-top-1">{regError}</p>
                                </div>
                            )}
                        </Card>
                    </TabsContent>

                    <TabsContent value="login">
                        <Card className="relative overflow-hidden border border-border/60 bg-card shadow-sm">
                            <BorderBeam duration={14} />
                            <CardHeader>
                                <CardTitle className="text-lg font-bold tracking-tight">Welcome Back</CardTitle>
                                <CardDescription className="text-foreground/80">
                                    {isLocked && auth.isAuthenticated
                                        ? 'Your session ended. Sign in again to continue.'
                                        : 'Enter your UUID and password to sign in.'}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <form id="login-form" onSubmit={(e) => { e.preventDefault(); if (isLocked && auth.isAuthenticated) { handleUnlock() } else { handleLogin() } }} className="space-y-4">
                                <div className="space-y-2">
                                    <Label className="text-xs font-medium text-foreground/80 uppercase" htmlFor="login-uuid">UUID</Label>
                                    <div className="relative">
                                        <Key className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                            id="login-uuid"
                                            name="username"
                                            autoComplete="username"
                                            placeholder="uuid-string..."
                                            className={`h-11 pl-10 font-mono text-sm ${notFoundError ? 'border-destructive' : ''}`}
                                            value={loginId}
                                            onChange={(e) => { setLoginId(e.target.value.trim()); setLoginError(null); }}
                                            disabled={isLocked && auth.isAuthenticated}
                                            autoFocus
                                        />
                                    </div>
                                    {notFoundError && (
                                        <p className="text-xs text-destructive font-medium animate-in slide-in-from-top-1">
                                            We couldn't find an account with this UUID. Make sure you copied the entire string correctly.
                                        </p>
                                    )}
                                </div>

                                <div className="space-y-2">
                                    <Label className="text-xs font-medium text-foreground/80 uppercase" htmlFor="login-password">Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                            id="login-password"
                                            name="password"
                                            type={showPassword ? "text" : "password"}
                                            placeholder="••••••••"
                                            className={`h-11 pl-10 pr-12 ${passwordError ? 'border-destructive' : ''}`}
                                            autoComplete="current-password"
                                            value={loginPass}
                                            onChange={(e) => { setLoginPass(e.target.value); setLoginError(null); }}
                                        />
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="absolute right-0 top-0 h-11 w-11 text-muted-foreground hover:text-foreground"
                                            onClick={() => setShowPassword(!showPassword)}
                                            aria-label={showPassword ? "Hide password" : "Show password"}
                                        >
                                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </Button>
                                    </div>
                                    {passwordError && (
                                        <p className="text-xs text-destructive font-medium animate-in slide-in-from-top-1">
                                            The password you entered is incorrect. Try again or check your Caps Lock.
                                        </p>
                                    )}
                                    {loginError && !notFoundError && !passwordError && !sessionRestoreError && (
                                        <p className="text-xs text-destructive font-medium animate-in slide-in-from-top-1">
                                            {loginError === 'Server error, try again later.'
                                                ? 'Something went wrong on our end. Wait a moment and try again.'
                                                : loginError}
                                        </p>
                                    )}
                                    {sessionRestoreError && (
                                        <div data-theme-tone="status" data-theme-part="panel" className="rounded-lg border border-warning/25 bg-warning/10 p-3 text-xs text-warning space-y-2 animate-in slide-in-from-top-1">
                                            <p className="font-medium">This browser session could not be restored.</p>
                                            <p className="text-warning/90">Sign in from cloud with this UUID/password to continue.</p>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="h-8 w-full border-warning/30 bg-background/60 text-warning hover:bg-warning/10"
                                                onClick={handleCloudRecoveryLogin}
                                                disabled={loading || isUnlocking}
                                            >
                                                Sign in from cloud
                                            </Button>
                                        </div>
                                    )}
                                </div>

                                {knownDeviceLogin ? (
                                    <p className="pt-1 text-xs text-muted-foreground">This device is remembered</p>
                                ) : (
                                    <div className="space-y-1.5 pt-1">
                                        <div className="flex items-start gap-2">
                                            <Checkbox
                                                id="remember-device"
                                                className="mt-0.5"
                                                checked={remember}
                                                onCheckedChange={(checked) => setRemember(checked === true)}
                                            />
                                            <Label htmlFor="remember-device" className="text-sm font-normal leading-snug cursor-pointer">
                                                Remember this device
                                            </Label>
                                        </div>
                                        <p className="pl-6 text-xs text-muted-foreground">
                                            Stay signed in on this device until you sign out or this browser clears its data.
                                        </p>
                                    </div>
                                )}
                                </form>

                                {isLocked && auth.isAuthenticated && unlockFailures >= 2 && (
                                    <div data-theme-tone="status" data-theme-part="panel" className="rounded-xl border border-warning/30 bg-warning/10 p-3 space-y-2 animate-in slide-in-from-top-1">
                                        <p className="text-xs font-semibold text-warning">Still not working? This browser's saved session may be corrupted.</p>
                                        <p className="text-xs text-muted-foreground leading-relaxed">
                                            Sign in from cloud instead: it resets this browser's broken saved session and restores everything from your sync. Anything already synced is safe.
                                        </p>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="h-8 w-full text-xs border-warning/30 bg-background/60 text-warning hover:bg-warning/10"
                                            disabled={loading || isUnlocking}
                                            onClick={handleCloudRecoveryLogin}
                                        >
                                            Sign in from cloud
                                        </Button>
                                    </div>
                                )}
                            </CardContent>
                            <CardFooter className="flex flex-col gap-3">
                                <Button
                                    type="submit"
                                    form="login-form"
                                    className="w-full gap-2"
                                    size="xl"
                                    variant="default"
                                    disabled={loading || isUnlocking}
                                >
                                    {loading || isUnlocking ? (
                                        <RefreshCw className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <LogIn className="h-4 w-4" />
                                    )}
                                    {loading || isUnlocking ? 'Signing in' : 'Login'}
                                </Button>

                                {gateInfo && (
                                    <>
                                        <div className="flex w-full items-center gap-3">
                                            <div className="h-px flex-1 bg-border" />
                                            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">or</span>
                                            <div className="h-px flex-1 bg-border" />
                                        </div>
                                        <div data-theme-part="panel" className="flex w-full items-center gap-3 rounded-xl border border-border/50 bg-muted/20 p-2.5">
                                            <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10">
                                            {auth.avatar ? (
                                                <img src={auth.avatar} alt="" className="h-full w-full object-cover" />
                                            ) : (
                                                <UserRound className="h-4 w-4 text-primary" />
                                            )}
                                        </div>
                                            <p className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">Continue as {gateInfo.label || 'saved sign-in'}</p>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="shrink-0 gap-1.5"
                                                onClick={handleContinueWithDevice}
                                                disabled={deviceBusy}
                                            >
                                                {deviceBusy ? (
                                                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                                ) : (
                                                    <Fingerprint className="h-3.5 w-3.5" />
                                                )}
                                                {deviceBusy ? 'Signing in' : 'Continue'}
                                            </Button>
                                        </div>
                                    </>
                                )}

                                {isLocked && auth.isAuthenticated && (
                                    <Button
                                        variant="link"
                                        className="text-xs text-foreground/80"
                                        onClick={() => setShowSwitchConfirm(true)}
                                    >
                                        Switch account
                                    </Button>
                                )}
                            </CardFooter>
                        </Card>
                    </TabsContent>
                </Tabs>

                {registrationsClosed && (
                    <p className="mt-4 text-center text-sm text-muted-foreground">Registrations are closed on this instance.</p>
                )}

                <ConfirmationDialog
                    open={showSwitchConfirm}
                    onOpenChange={setShowSwitchConfirm}
                    title="Switch account?"
                    description="Clear the local session and switch accounts?"
                    confirmText="Switch"
                    cancelText="Cancel"
                    isDestructive={true}
                    onConfirm={async () => {
                        await logout()
                        window.location.reload()
                    }}
                />

                <Dialog open={showRegSuccess} onOpenChange={(open) => { if (!open && !hasCopied) return; setShowRegSuccess(open) }}>
                    <DialogContent className="sm:max-w-md" hideClose>
                        <DialogHeader>
                            <div className="flex justify-center mb-4">
                                <div className="h-12 w-12 rounded-full bg-success/10 flex items-center justify-center">
                                    <Rocket className="h-6 w-6 text-success" />
                                </div>
                            </div>
                            <DialogTitle className="text-center">Account created</DialogTitle>
                            <DialogDescription className="text-center pt-2">
                                Save this UUID. It is the only way to sign in again.
                            </DialogDescription>
                        </DialogHeader>

                        <div className="space-y-4 py-4">
                            <div className="space-y-2">
                                <Label className="text-xs font-medium text-muted-foreground uppercase">Account UUID</Label>
                                <div className="relative group">
                                    <div data-theme-part="field" className="p-4 bg-success/10 rounded-lg border border-success/20 flex items-center justify-between gap-3 group-hover:border-success/40 transition-colors">
                                        <code
                                            className="text-sm font-mono font-bold break-all text-success"
                                            onCopy={() => setHasCopied(true)}
                                        >
                                            {registeredId}
                                        </code>
                                        <CopyButton
                                            value={registeredId}
                                            className="shrink-0 h-10 w-10"
                                            iconSize={16}
                                            onCopied={() => setHasCopied(true)}
                                        />
                                    </div>
                                </div>
                                {!hasCopied && (
                                    <p className="text-xs text-muted-foreground">Copy your UUID above before continuing. Select it and press Ctrl+C if the button does not work.</p>
                                )}
                            </div>

                            <div data-theme-tone="status" data-theme-part="panel" className="bg-warning/10 border border-warning/20 rounded-lg p-3 space-y-2">
                                <div className="flex items-center gap-2 text-warning font-semibold text-xs uppercase">
                                    <ShieldAlert className="h-4 w-4" />
                                    No password reset
                                </div>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    AIOManager does not store your password. If you lose this UUID or password, the encrypted data cannot be recovered.
                                </p>
                            </div>
                        </div>

                        <DialogFooter className="sm:justify-center flex-col gap-2">
                            <Button
                                className="w-full font-semibold"
                                size="xl"
                                onClick={() => navigate('/')}
                                disabled={!hasCopied}
                            >
                                Enter dashboard
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                    <Suspense fallback={null}>
                        <DashboardEntry />
                    </Suspense>
                    <Link
                        to="/kronorium"
                        className="text-xs text-muted-foreground hover:text-primary transition-colors"
                    >
                        Read the Kronorium →
                    </Link>
                </div>

                <p className="text-center text-xs text-muted-foreground font-mono">
                    v{pkg.version}{(pkg as Record<string, unknown>).build ? ` · Build ${(pkg as Record<string, unknown>).build}` : ''}
                </p>
            </div>
        </div>
    )
}
