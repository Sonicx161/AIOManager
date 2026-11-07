import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Lock, Eye, EyeOff, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { BrandLogo } from '@/components/common/BrandLogo'
import { useTheme } from '@/contexts/ThemeContext'
import { submitSignIn, signInErrorText } from '@/components/admin/sign-in-form'

/**
 * Dashboard sign-in with a username and password, laid out like the app login:
 * logo mark and wordmark above one card, no icon tile beside the title. Saving the
 * credentials is left to the browser password manager; "Remember this browser"
 * only lengthens the server session. Setup mode is the one-time provisioning flow.
 */
export function SignInScreen({ mode, setupAvailable = true, readOnlyReplica = false, rememberedBrowser = false }: { mode: 'signin' | 'setup'; setupAvailable?: boolean; readOnlyReplica?: boolean; rememberedBrowser?: boolean }) {
  const queryClient = useQueryClient()
  const { logoUrl } = useTheme()
  const [setupToken, setSetupToken] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const setup = mode === 'setup'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await submitSignIn(mode, { setupToken, username, password, confirmPassword, remember })
      await queryClient.invalidateQueries({ queryKey: ['admin-status'] })
    } catch (err) {
      setError(signInErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center pb-[calc(env(safe-area-inset-bottom,0px)+0.5rem)] md:min-h-[calc(100dvh-12rem)] md:justify-center md:py-12">
      <div className="mb-4 space-y-1 text-center md:mb-6">
        <div className="flex justify-center">
          <BrandLogo logoUrl={logoUrl} className="h-14 w-14 text-foreground md:h-16 md:w-16" />
        </div>
        <p className="text-2xl font-bold tracking-tighter">AIOManager</p>
        <p className="text-sm text-muted-foreground">Dashboard</p>
      </div>

      <Card className="w-full border border-border/60 bg-card shadow-sm">
        <CardHeader>
          <CardTitle id="dashboard-signin-title" className="text-lg font-bold tracking-tight">
            {setup ? 'Set up the Dashboard' : 'Sign in'}
          </CardTitle>
          <CardDescription className="text-foreground/80">
            {setup ? 'Choose the username and password for this Dashboard.' : 'Use the Dashboard username and password.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form id="dashboard-signin-form" onSubmit={submit} className="space-y-4" aria-labelledby="dashboard-signin-title">
            {readOnlyReplica && (
              <p role="note" className="rounded-xl border border-warning/25 bg-warning/10 px-3 py-2 text-xs font-medium text-warning">
                This instance is a read-only replica; sign-in is refused here. Make changes on the primary.
              </p>
            )}
            {setup && !setupAvailable && (
              <p role="note" className="rounded-xl border border-warning/25 bg-warning/10 px-3 py-2 text-xs font-medium text-warning">
                No setup token is active on the server. Set a one-time ADMIN_SETUP token in the server .env and retry.
              </p>
            )}
            {setup && (
              <div className="space-y-2">
                <Label htmlFor="dashboard-setup-token" className="text-xs font-semibold text-muted-foreground">One-time setup token</Label>
                <Input
                  id="dashboard-setup-token"
                  value={setupToken}
                  onChange={e => setSetupToken(e.target.value)}
                  autoComplete="off"
                  className="h-11"
                  required
                  autoFocus
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="dashboard-username" className="text-xs font-semibold text-muted-foreground">Username</Label>
              <div className="relative">
                <UserRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  id="dashboard-username"
                  name="username"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  autoComplete="username"
                  className="h-11 pl-10"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  autoFocus={!setup}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dashboard-password" className="text-xs font-semibold text-muted-foreground">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  id="dashboard-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete={setup ? 'new-password' : 'current-password'}
                  className="h-11 pl-10 pr-12"
                  required
                  aria-describedby={error ? 'dashboard-signin-error' : undefined}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-11 w-11 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {setup && <p className="text-xs text-muted-foreground">At least 14 characters.</p>}
            </div>
            {setup && (
              <div className="space-y-2">
                <Label htmlFor="dashboard-confirm-password" className="text-xs font-semibold text-muted-foreground">Confirm password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    id="dashboard-confirm-password"
                    name="confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    className="h-11 pl-10 pr-12"
                    required
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-11 w-11 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-1.5 pt-1">
              <div className="flex items-start gap-2">
                <Checkbox
                  id="remember-browser"
                  className="mt-0.5"
                  checked={remember}
                  onCheckedChange={checked => setRemember(checked === true)}
                />
                <Label htmlFor="remember-browser" className="cursor-pointer text-sm font-normal leading-snug">
                  Remember this browser
                </Label>
              </div>
              <p className="pl-6 text-xs text-muted-foreground">
                {rememberedBrowser ? 'This browser is remembered from a previous sign-in.' : 'Stay signed in on this browser for up to 30 days.'}
              </p>
            </div>

            {error && (
              <p id="dashboard-signin-error" role="alert" className="rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
                {error}
              </p>
            )}
          </form>
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" form="dashboard-signin-form" className="w-full gap-2" size="xl" disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {setup ? 'Create and sign in' : 'Sign in'}
          </Button>
        </CardFooter>
      </Card>

      <div className="mt-3">
        <Link to="/" className="text-xs text-muted-foreground hover:text-primary transition-colors">Back to the app</Link>
      </div>
    </div>
  )
}
