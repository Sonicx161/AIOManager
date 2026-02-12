import { useState, useEffect } from 'react'
import { useSyncStore } from '@/store/syncStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Rocket, Lock, Key, LogIn, RefreshCw, Eye, EyeOff, ShieldAlert } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { useSearchParams } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import pkg from '../../package.json'

export function LoginPage() {
    const { auth, register, login, logout } = useSyncStore()
    const { isLocked, unlock } = useAuthStore()
    const [searchParams] = useSearchParams()

    // State
    const [mode, setMode] = useState<'login' | 'register'>('login')
    const [showPassword, setShowPassword] = useState(false)
    const [customHtml, setCustomHtml] = useState<string | null>(null)
    const [isUnlocking, setIsUnlocking] = useState(false)
    const [showSwitchConfirm, setShowSwitchConfirm] = useState(false)

    // Login Fields
    const [loginId, setLoginId] = useState(auth.id || '')
    const [loginPass, setLoginPass] = useState('')

    // Register Fields
    const [regPass, setRegPass] = useState('')
    const [regPassConfirm, setRegPassConfirm] = useState('')
    const [isRegistering, setIsRegistering] = useState(false)

    // Shared
    const [loading, setLoading] = useState(false)
    const [loginError, setLoginError] = useState<string | null>(null)

    const passwordsMatch = regPass === regPassConfirm || !regPassConfirm

    // Fetch custom HTML from server config
    useEffect(() => {
        fetch('/api/config')
            .then(res => res.json())
            .then(data => {
                if (data.customHtml) setCustomHtml(data.customHtml)
            })
            .catch(() => { /* Silently fail - optional feature */ })
    }, [])

    // Auto-fill ID from URL
    useEffect(() => {
        const idParam = searchParams.get('id')
        if (idParam) {
            setLoginId(idParam)
            setMode('login')
            toast({ title: "Account Detected", description: "Please enter your password to unlock." })
        }
    }, [searchParams])

    const handleRegister = async () => {
        if (!regPass) {
            toast({ variant: "destructive", title: "Password Required", description: "Please choose a password." })
            return
        }

        if (regPass !== regPassConfirm) {
            toast({ variant: "destructive", title: "Passwords Mismatch", description: "Please ensure both passwords match." })
            return
        }

        setIsRegistering(true)
        try {
            await register(regPass)
            // Store handles redirect/state update
        } catch (e) {
            console.error("Registration error:", e)
            // Toast handled in store
        } finally {
            setIsRegistering(false)
        }
    }

    const handleUnlock = async () => {
        if (!loginPass) {
            toast({ variant: "destructive", title: "Password Required", description: "Please enter your master password." })
            return
        }

        setIsUnlocking(true)
        setLoginError(null)

        try {
            const success = await unlock(loginPass)
            if (!success) {
                setLoginError('Invalid Password')
            } else {
                toast({ title: "Welcome Back", description: "Vault unlocked successfully." })
            }
        } catch (e) {
            const msg = (e as Error).message

            if (msg.includes('not initialized')) {
                console.log('[Auth] Local DB empty. Attempting Cloud Restore...')
                try {
                    await login(auth.id, loginPass, true) // Silent login to restore
                    toast({ title: "Restored", description: "Session restored from cloud." })
                } catch (restoreErr) {
                    console.error('[Auth] Cloud restore failed:', restoreErr)
                    setLoginError("No local data found and cloud restore failed. Please log in from your original browser to sync first.")
                }
            } else {
                setLoginError(msg)
                console.error("Unlock error:", e)
            }
        } finally {
            setIsUnlocking(false)
        }
    }

    const handleLogin = async () => {
        if (!loginId || !loginPass) {
            toast({ variant: "destructive", title: "Missing Credentials", description: "ID and Password are required." })
            return
        }

        setLoading(true)
        setLoginError(null)
        try {
            await login(loginId, loginPass)
        } catch (e) {
            setLoginError((e as Error).message)
            console.error("Login error:", e)
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4 animate-in fade-in zoom-in-95 duration-300">
            <div className="max-w-md w-full space-y-8">
                {/* Custom HTML Injection (for hosted deployments) */}
                {customHtml && (
                    <div
                        className="custom-html-container"
                        dangerouslySetInnerHTML={{ __html: customHtml }}
                    />
                )}

                {/* Branding */}
                <div className="text-center space-y-2">
                    <div className="flex justify-center mb-6">
                        <img
                            src="/logo.png"
                            alt="AIOManager"
                            className="h-24 w-24 object-contain transition-all hover:scale-110 duration-500"
                        />
                    </div>
                    <h1 className="text-3xl font-bold tracking-tight">AIOManager</h1>
                    <p className="text-muted-foreground">One manager to rule them all.</p>
                </div>

                {!window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && (
                    <div className="bg-destructive/10 border border-destructive/20 p-4 rounded-lg space-y-2 animate-in slide-in-from-top-2 duration-500">
                        <div className="flex items-center gap-2 text-destructive font-semibold">
                            <ShieldAlert className="h-5 w-5" />
                            <span>Insecure Connection Detected</span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                            AIOManager <strong>only works</strong> over a <strong>Secure Context (HTTPS)</strong>.
                            Encryption and Sync APIs are disabled by your browser on insecure connections.
                            Please use a reverse proxy or access via <code>localhost</code>.
                        </p>
                        <div className="pt-1">
                            <a
                                href="https://github.com/Sonicx161/AIOManager#secure-context-https-required"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[10px] text-destructive/80 hover:text-destructive underline flex items-center gap-1"
                            >
                                Advanced: Remote HTTP Workaround
                            </a>
                        </div>
                    </div>
                )}

                <Tabs value={mode} onValueChange={(v) => { setMode(v as any); setShowPassword(false); }} className="w-full">
                    <TabsList className="grid w-full grid-cols-2 mb-6 h-12">
                        <TabsTrigger value="register" className="h-10">New Account</TabsTrigger>
                        <TabsTrigger value="login" className="h-10">Login</TabsTrigger>
                    </TabsList>

                    <TabsContent value="register">
                        <Card className="border-2 shadow-sm">
                            <CardHeader>
                                <CardTitle>Create Identity</CardTitle>
                                <CardDescription>Generate a unique UUID to store your configuration.</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="space-y-2">
                                    <Label>Account UUID</Label>
                                    <div className="p-3 bg-muted rounded-md border border-dashed text-center">
                                        <p className="text-xs text-muted-foreground">
                                            A unique UUID key will be generated for you automatically upon creation.
                                        </p>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label>Choose a Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                        <Input
                                            type={showPassword ? "text" : "password"}
                                            placeholder="••••••••"
                                            className="pl-9 pr-10"
                                            value={regPass}
                                            onChange={(e) => setRegPass(e.target.value)}
                                        />
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="absolute right-0 top-0 h-9 w-9 text-muted-foreground hover:text-foreground"
                                            onClick={() => setShowPassword(!showPassword)}
                                        >
                                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </Button>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label>Confirm Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                        <Input
                                            type={showPassword ? "text" : "password"}
                                            placeholder="••••••••"
                                            className={`pl-9 pr-10 ${!passwordsMatch ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                                            value={regPassConfirm}
                                            onChange={(e) => setRegPassConfirm(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
                                        />
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="absolute right-0 top-0 h-9 w-9 text-muted-foreground hover:text-foreground"
                                            onClick={() => setShowPassword(!showPassword)}
                                        >
                                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </Button>
                                    </div>
                                    {!passwordsMatch && (
                                        <p className="text-[10px] text-destructive font-medium animate-in slide-in-from-top-1">
                                            Passwords do not match
                                        </p>
                                    )}
                                    <p className="text-[11px] text-muted-foreground pt-1">
                                        This password is the <strong>only key</strong> to your data. Do not lose it.
                                    </p>
                                </div>
                            </CardContent>
                            <CardFooter>
                                <Button className="w-full h-11 text-base" onClick={handleRegister} disabled={isRegistering}>
                                    {isRegistering ? (
                                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                        <Rocket className="mr-2 h-4 w-4" />
                                    )}
                                    {isRegistering ? 'Creating...' : 'Create & Enter'}
                                </Button>
                            </CardFooter>
                        </Card>
                    </TabsContent>

                    <TabsContent value="login">
                        <Card className="border-2 shadow-sm">
                            <CardHeader>
                                <CardTitle>{isLocked && auth.isAuthenticated ? 'Unlock Vault' : 'Welcome Back'}</CardTitle>
                                <CardDescription>
                                    {isLocked && auth.isAuthenticated
                                        ? 'Enter your master password to access your encrypted session.'
                                        : 'Enter your UUID to access your session.'}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="space-y-2">
                                    <Label>UUID</Label>
                                    <div className="relative">
                                        <Key className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                        <Input
                                            placeholder="uuid-string..."
                                            className={`pl-9 font-mono text-sm ${loginError === 'Account ID not found' ? 'border-destructive' : ''}`}
                                            value={loginId}
                                            onChange={(e) => { setLoginId(e.target.value.trim()); setLoginError(null); }}
                                            disabled={isLocked && auth.isAuthenticated}
                                        />
                                    </div>
                                    {loginError === 'Account ID not found' && (
                                        <p className="text-[11px] text-destructive font-medium animate-in slide-in-from-top-1">
                                            We couldn't find an account with this UUID. Please make sure you copied the entire string correctly.
                                        </p>
                                    )}
                                </div>

                                <div className="space-y-2">
                                    <Label>Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                        <Input
                                            type={showPassword ? "text" : "password"}
                                            placeholder="••••••••"
                                            className={`pl-9 pr-10 ${loginError === 'Invalid Password' ? 'border-destructive' : ''}`}
                                            value={loginPass}
                                            onChange={(e) => { setLoginPass(e.target.value); setLoginError(null); }}
                                            onKeyDown={(e) => e.key === 'Enter' && (isLocked && auth.isAuthenticated ? handleUnlock() : handleLogin())}
                                        />
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="absolute right-0 top-0 h-9 w-9 text-muted-foreground hover:text-foreground"
                                            onClick={() => setShowPassword(!showPassword)}
                                        >
                                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </Button>
                                    </div>
                                    {loginError === 'Invalid Password' && (
                                        <p className="text-[11px] text-destructive font-medium animate-in slide-in-from-top-1">
                                            The password you entered is incorrect. Please try again or check your Caps Lock.
                                        </p>
                                    )}
                                    {loginError && loginError !== 'Account ID not found' && loginError !== 'Invalid Password' && (
                                        <p className="text-[11px] text-destructive font-medium animate-in slide-in-from-top-1">
                                            {loginError === 'Server error, please try again later.'
                                                ? 'Something went wrong on our end. Please wait a moment and try again.'
                                                : loginError}
                                        </p>
                                    )}
                                </div>
                            </CardContent>
                            <CardFooter className="flex flex-col gap-3">
                                <Button
                                    className="w-full h-11 text-base"
                                    variant="default"
                                    onClick={isLocked && auth.isAuthenticated ? handleUnlock : handleLogin}
                                    disabled={loading || isUnlocking}
                                >
                                    {loading || isUnlocking ? (
                                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                        isLocked && auth.isAuthenticated ? <Lock className="mr-2 h-4 w-4" /> : <LogIn className="mr-2 h-4 w-4" />
                                    )}
                                    {loading ? 'Syncing...' : isUnlocking ? 'Unlocking...' : isLocked && auth.isAuthenticated ? 'Unlock System' : 'Login'}
                                </Button>

                                {isLocked && auth.isAuthenticated && (
                                    <Button
                                        variant="link"
                                        className="text-xs text-muted-foreground"
                                        onClick={() => setShowSwitchConfirm(true)}
                                    >
                                        Switch Account?
                                    </Button>
                                )}
                            </CardFooter>
                        </Card>
                    </TabsContent>
                </Tabs>

                <ConfirmationDialog
                    open={showSwitchConfirm}
                    onOpenChange={setShowSwitchConfirm}
                    title="Switch Account?"
                    description="Clear local session and switch accounts?"
                    confirmText="Switch"
                    cancelText="Cancel"
                    isDestructive={true}
                    onConfirm={() => {
                        logout()
                        window.location.reload()
                    }}
                />

                <p className="text-center text-xs text-muted-foreground">
                    AIOManager v{pkg.version}
                </p>
            </div>
        </div>
    )
}
