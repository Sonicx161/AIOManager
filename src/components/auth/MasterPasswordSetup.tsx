import { useState } from 'react'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'

export function MasterPasswordSetup() {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const setupMasterPassword = useAuthStore((state) => state.setupMasterPassword)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    // Validation
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    try {
      setIsSubmitting(true)
      await setupMasterPassword(password)
      // Success - store will update state and app will continue
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set up password')
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center animate-mesh p-4 relative overflow-hidden">

      <Card className="w-full max-w-md relative z-10 glass-card animate-slide-up overflow-hidden">
        {/* Subtle top highlight line */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[80%] h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

        <CardHeader className="text-center pb-2 pt-8">
          <div className="mx-auto mb-8 w-24 h-24 bg-white/5 border border-white/10 rounded-3xl flex items-center justify-center shadow-2xl relative group overflow-hidden">
            <div className="absolute inset-0 bg-blue-500/10 blur-2xl group-hover:bg-blue-500/20 transition-colors" />
            <img src="/logo.png" alt="Logo" className="w-16 h-16 relative z-10 transition-transform group-hover:rotate-12" />
          </div>
          <CardTitle className="text-3xl font-bold tracking-tight text-white mb-1">
            Setup AIOManager
          </CardTitle>
          <CardDescription className="text-slate-400">
            Create a password to encrypt your Stremio credentials
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password (8+ characters)"
                className="bg-white/5 border-white/10 focus:border-white/20 focus:ring-white/5 h-12 text-lg text-center tracking-widest placeholder:tracking-normal placeholder:text-slate-600 font-mono"
                disabled={isSubmitting}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm Password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                className="bg-white/5 border-white/10 focus:border-white/20 focus:ring-white/5 h-12 text-lg text-center tracking-widest placeholder:tracking-normal placeholder:text-slate-600 font-mono"
                disabled={isSubmitting}
              />
            </div>

            {error && (
              <Alert
                variant="destructive"
                className="bg-destructive/10 border-destructive/20 text-destructive-foreground"
              >
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Alert className="bg-blue-500/5 border-blue-500/20 text-blue-400">
              <AlertDescription className="text-sm">
                <strong>Important:</strong> This password encrypts your credentials. If you lose it,
                you will lose access to all stored accounts.
              </AlertDescription>
            </Alert>

            <Button
              type="submit"
              className="w-full bg-white text-black hover:bg-slate-200 transition-all py-6 text-lg font-bold shadow-xl shadow-black/20"
              disabled={isSubmitting || !password || !confirmPassword}
            >
              {isSubmitting ? 'Configuring...' : 'Initialize System'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
