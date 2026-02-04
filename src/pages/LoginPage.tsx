import { useState, useEffect } from 'react'
import { useSyncStore } from '@/store/syncStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Rocket, Lock, Key, LogIn, RefreshCw, Eye, EyeOff } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { useSearchParams } from 'react-router-dom'
import pkg from '../../package.json'

export function LoginPage() {
    const { register, login } = useSyncStore()
    const [searchParams] = useSearchParams()

    // State
    const [mode, setMode] = useState<'login' | 'register'>('login')
    const [showPassword, setShowPassword] = useState(false)

    // Login Fields
    const [loginId, setLoginId] = useState('')
    const [loginPass, setLoginPass] = useState('')

    // Register Fields
    const [regPass, setRegPass] = useState('')
    const [regPassConfirm, setRegPassConfirm] = useState('')
    const [isRegistering, setIsRegistering] = useState(false)

    // Shared
    const [loading, setLoading] = useState(false)
    const [loginError, setLoginError] = useState<string | null>(null)

    const passwordsMatch = regPass === regPassConfirm || !regPassConfirm

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
            // Toast still handled in store
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4 animate-in fade-in zoom-in-95 duration-300">
            <div className="max-w-md w-full space-y-8">
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
                                <CardTitle>Welcome Back</CardTitle>
                                <CardDescription>Enter your UUID to access your session.</CardDescription>
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
                                            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
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
                            <CardFooter>
                                <Button className="w-full h-11 text-base" variant="default" onClick={handleLogin} disabled={loading}>
                                    {loading ? (
                                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                        <LogIn className="mr-2 h-4 w-4" />
                                    )}
                                    {loading ? 'Syncing...' : 'Login'}
                                </Button>
                            </CardFooter>
                        </Card>
                    </TabsContent>
                </Tabs>

                <p className="text-center text-xs text-muted-foreground">
                    AIOManager v{pkg.version}
                </p>
            </div>
        </div>
    )
}
