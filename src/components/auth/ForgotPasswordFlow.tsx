import { useState } from 'react'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertTriangle } from 'lucide-react'

interface ForgotPasswordFlowProps {
  onCancel: () => void
  onComplete: () => void
}

export function ForgotPasswordFlow({ onCancel, onComplete }: ForgotPasswordFlowProps) {
  const [step, setStep] = useState<'warning' | 'reset-password'>('warning')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const resetMasterPassword = useAuthStore((state) => state.resetMasterPassword)

  const handleReset = async (e: React.FormEvent) => {
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
      await resetMasterPassword(password)
      // Success - app will unlock automatically
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password')
      setIsSubmitting(false)
    }
  }

  // Step 1: Warning Dialog
  if (step === 'warning') {
    return (
      <div className="min-h-screen flex items-center justify-center animate-mesh p-4 relative overflow-hidden">

        <Card className="w-full max-w-md relative z-10 glass-card animate-slide-up overflow-hidden">
          {/* Subtle top highlight line */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[80%] h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

          <CardHeader className="text-center pb-2 pt-8">
            <div className="mx-auto mb-6 w-20 h-20 bg-red-500/5 border border-red-500/10 rounded-3xl flex items-center justify-center shadow-2xl relative group overflow-hidden">
              <div className="absolute inset-0 bg-red-500/10 blur-xl rounded-full opacity-100 transition-opacity" />
              <AlertTriangle className="w-10 h-10 text-red-400 relative z-10" />
            </div>
            <CardTitle className="text-2xl font-semibold tracking-tight text-white">
              Reset Master Password
            </CardTitle>
            <CardDescription className="text-slate-400">
              This will permanently delete all your data
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert
              variant="destructive"
              className="bg-destructive/10 border-destructive/20 text-destructive-foreground"
            >
              <AlertDescription className="text-sm">
                <strong>Warning:</strong> This action cannot be undone. The following data will be
                permanently deleted:
              </AlertDescription>
            </Alert>

            <div className="space-y-2 text-sm text-slate-300 bg-slate-900/50 border border-slate-800 rounded-lg p-4">
              <div className="flex items-start gap-2">
                <span className="text-red-400">•</span>
                <span>All saved Stremio accounts and credentials</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-red-400">•</span>
                <span>Your entire addon library</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-red-400">•</span>
                <span>All account-addon configurations</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-red-400">•</span>
                <span>Your current master password</span>
              </div>
            </div>

            <Alert className="bg-blue-500/5 border-blue-500/20 text-blue-400">
              <AlertDescription className="text-sm">
                After resetting, you will set a new master password and start with an empty account
                manager.
              </AlertDescription>
            </Alert>

            <div className="flex flex-col gap-2 pt-2">
              <Button
                variant="destructive"
                className="w-full py-6 text-base font-medium"
                onClick={() => setStep('reset-password')}
              >
                Yes, Reset Data
              </Button>
              <Button
                variant="outline"
                className="w-full py-6 text-base font-medium bg-transparent border-slate-700 hover:bg-slate-800"
                onClick={onCancel}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Step 2: Password Reset Form
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
            Reset Master Password
          </CardTitle>
          <CardDescription className="text-slate-400 text-base">
            Create a new password for your manager
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleReset} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-password">New Password</Label>
              <Input
                id="new-password"
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
              <Label htmlFor="confirm-new-password">Confirm New Password</Label>
              <Input
                id="confirm-new-password"
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

            <div className="flex flex-col gap-2 pt-2">
              <Button
                type="submit"
                className="w-full bg-white text-black hover:bg-slate-200 transition-all py-6 text-lg font-bold shadow-xl shadow-black/20"
                disabled={isSubmitting || !password || !confirmPassword}
              >
                {isSubmitting ? 'Resetting...' : 'Set New Password'}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full py-6 text-base font-medium bg-transparent border-slate-700 hover:bg-slate-800"
                onClick={onCancel}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
