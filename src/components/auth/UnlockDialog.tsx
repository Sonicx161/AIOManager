import { useState } from 'react'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ForgotPasswordFlow } from './ForgotPasswordFlow'

export function UnlockDialog() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showForgotPassword, setShowForgotPassword] = useState(false)

  const unlock = useAuthStore((state) => state.unlock)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!password) {
      setError('Please enter your password')
      return
    }

    try {
      setIsSubmitting(true)
      const success = await unlock(password)

      if (!success) {
        setError('Incorrect password')
        setPassword('')
        setIsSubmitting(false)
      }
      // If success, isLocked becomes false and dialog disappears
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlock')
      setIsSubmitting(false)
    }
  }

  // Show forgot password flow if requested
  if (showForgotPassword) {
    return (
      <ForgotPasswordFlow
        onCancel={() => setShowForgotPassword(false)}
        onComplete={() => {
          setShowForgotPassword(false)
          // Reset will unlock automatically
        }}
      />
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center animate-mesh p-4 relative overflow-hidden">
      <Card className="w-full max-w-md relative z-10 glass-card animate-slide-up overflow-hidden">
        {/* Subtle top highlight line */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[80%] h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

        <CardHeader className="text-center pb-2 pt-8">
          <div className="mx-auto mb-8 w-24 h-24 bg-white/5 border border-white/10 rounded-3xl flex items-center justify-center shadow-2xl relative group overflow-hidden">
            {/* Glow effect */}
            <div className="absolute inset-0 bg-blue-500/10 blur-2xl group-hover:bg-blue-500/20 transition-colors" />

            <img
              src="/logo.png"
              alt="Logo"
              className={`w-16 h-16 relative z-10 transition-transform duration-700 ${isSubmitting ? 'animate-gear-spin' : 'group-hover:rotate-12'}`}
            />
          </div>
          <CardTitle className="text-3xl font-bold tracking-tight text-white mb-1">
            Unlock AIOManager
          </CardTitle>
          <CardDescription className="text-slate-400 text-base">
            Unified control for your Stremio accounts and addons
          </CardDescription>
        </CardHeader>

        <CardContent className="pb-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="password text-slate-300">Master Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="bg-white/5 border-white/10 focus:border-white/20 focus:ring-white/5 h-12 text-lg text-center tracking-widest placeholder:tracking-normal placeholder:text-slate-600"
                disabled={isSubmitting}
                autoFocus
              />
              <div className="flex justify-center">
                <Button
                  variant="link"
                  size="sm"
                  className="text-xs text-slate-500 hover:text-slate-300 px-0 transition-colors"
                  onClick={() => setShowForgotPassword(true)}
                  type="button"
                >
                  Forgot Password?
                </Button>
              </div>
            </div>

            {error && (
              <Alert
                variant="destructive"
                className="bg-red-500/10 border-red-500/20 text-red-200 py-3"
              >
                <AlertDescription className="text-center text-sm">{error}</AlertDescription>
              </Alert>
            )}

            <Button
              type="submit"
              className="w-full bg-white text-black hover:bg-slate-200 transition-all py-6 text-lg font-bold shadow-xl shadow-black/20"
              disabled={isSubmitting || !password}
            >
              {isSubmitting ? 'Verifying...' : 'Unlock System'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
