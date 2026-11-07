import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2, Lock, Mail, Key, QrCode, RefreshCw, Eye, EyeOff } from 'lucide-react'
import { loginWithCredentials } from '@/api/auth'
import { stremioClient } from '@/api/stremio-client'
import { createStremioLink, pollStremioLink } from '@/api/stremio-link'
import type { QRSession } from '@/lib/qr-device-link'
import { QRLinkDialog } from '@/components/qr/QRLinkDialog'
import { StremioSocialAuth } from '@/components/accounts/StremioSocialAuth'
import { useAuthStore } from '@/store/authStore'
import { useAccountStore, getStremioAuthKey, getCachedAuthKey } from '@/store/accountStore'

export interface StremioSignIn {
    /** Verified plain-text auth key; the caller seals it before persisting. */
    authKey: string
    /** Email reported by the verified Stremio user, when available. */
    email?: string
    /** Human-readable id of the verified user, used for labels. */
    userId?: string
}

interface StremioSetupDialogProps {
    accountId: string
    open: boolean
    onOpenChange: (open: boolean) => void
    onComplete: (signIn: StremioSignIn) => Promise<void>
    /** The caller unmounts this dialog on return, which discards all wizard state. */
    onBackToPicker?: () => void
}

const errMsg = (e: unknown, fallback = 'Try again.') => (e instanceof Error ? e.message : fallback)

/**
 * Adds another Stremio login to an existing local account. Every method verifies the
 * session against Stremio before it is handed to onComplete — a placeholder
 * "needs sign-in" connection can no longer be created from here — and the same remote
 * login cannot be bound twice to one account.
 */
export function StremioSetupDialog({ accountId, open, onOpenChange, onComplete, onBackToPicker }: StremioSetupDialogProps) {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [authKeyInput, setAuthKeyInput] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [qrOpen, setQrOpen] = useState(false)

    const emailValid = email.includes('@')
    const passwordValid = password.length > 0

    // Duplicate guard, keyed on the verified remote identity: two DIFFERENT sessions of
    // the same remote user (fresh login, rotated key) share the same _id, so the userId
    // comparison catches what a sealed-key equality check cannot. Legacy rows without a
    // stored userId still fall back to decrypting and comparing keys.
    const alreadyBoundHere = async (authKey: string, encryptionKey: CryptoKey, userId?: string): Promise<boolean> => {
        const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
        if (!account) return false
        const storedStremio = (account.connections || []).filter(c => c.platform === 'stremio' && (c.connectionType == null || c.connectionType === 'native'))
        if (userId && storedStremio.some(c => c.credentials?.userId === userId)) return true
        const sealedKeys = [
            ...storedStremio.map(c => c.credentials?.authKey),
            // Legacy accounts keep their only login in account.authKey with no stored
            // connection; getStremioAuthKey synthesizes it, so compare it too.
            ...(storedStremio.length > 0 ? [] : [getStremioAuthKey(account)]),
        ].filter((k): k is string => !!k)
        for (const sealed of sealedKeys) {
            const existing = await getCachedAuthKey(sealed, encryptionKey).catch(() => null)
            if (existing === authKey) return true
        }
        return false
    }

    const claim = async (authKey: string, fallbackEmail?: string) => {
        setBusy(true)
        setError('')
        try {
            const key = useAuthStore.getState().encryptionKey
            if (!key) throw new Error('Unlock your vault before saving a connection')
            // Verified sign-in: the key must resolve to a live Stremio user.
            const user = await stremioClient.getUser(authKey)
            if (await alreadyBoundHere(authKey, key, user._id)) {
                throw new Error('This Stremio account is already connected to this AIOManager account.')
            }
            // The duplicate scan read the store asynchronously; re-verify the vault key
            // is still the one the caller unlocked before any sealing happens.
            if (useAuthStore.getState().encryptionKey !== key) {
                throw new Error('Your vault changed while saving. Unlock it and try again.')
            }
            await onComplete({
                authKey,
                email: (typeof user.email === 'string' && user.email.trim()) || fallbackEmail,
                userId: user._id,
            })
            onOpenChange(false)
            setPassword('')
            setAuthKeyInput('')
            setEmail('')
        } catch (err) {
            setError(errMsg(err))
        } finally {
            setBusy(false)
        }
    }

    const handlePasswordSignIn = async () => {
        if (!emailValid || !passwordValid || busy) return
        setBusy(true)
        setError('')
        try {
            const response = await loginWithCredentials(email, password)
            await claim(response.authKey, response.user?.email || email)
        } catch (err) {
            setError(errMsg(err))
        } finally {
            setBusy(false)
        }
    }

    const handleAuthKeySignIn = async () => {
        const trimmed = authKeyInput.trim()
        if (!trimmed || busy) return
        await claim(trimmed)
    }

    const handleQrClaimed = async (session: QRSession) => {
        const authKey = (session.platformData as { authKey?: string } | undefined)?.authKey
        if (!authKey) {
            setError('QR approval did not return a session. Try again.')
            return
        }
        await claim(authKey)
        setQrOpen(false)
    }

    return (
        <>
            <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Add a Stremio login</DialogTitle>
                        <DialogDescription>
                            Sign in with a Stremio account to bind it to this AIOManager account. Each login keeps its own sealed session; the first one stays the primary addon connection.
                        </DialogDescription>
                    </DialogHeader>
                    <Tabs defaultValue="password" className="mt-2">
                        <TabsList>
                            <TabsTrigger value="password">Password</TabsTrigger>
                            <TabsTrigger value="qr">QR Code</TabsTrigger>
                            <TabsTrigger value="authkey">Auth Key</TabsTrigger>
                        </TabsList>
                        <TabsContent value="password" className="space-y-3">
                            <div className="space-y-2">
                                <Label htmlFor="stremio-setup-email">Email</Label>
                                <div className="relative">
                                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        id="stremio-setup-email"
                                        type="email"
                                        placeholder="you@example.com"
                                        value={email}
                                        onChange={e => { setEmail(e.target.value); setError('') }}
                                        className="pl-10"
                                        autoFocus
                                    />
                                </div>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="stremio-setup-password">Password</Label>
                                <div className="relative">
                                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        id="stremio-setup-password"
                                        type={showPassword ? 'text' : 'password'}
                                        placeholder="Your Stremio password"
                                        value={password}
                                        onChange={e => { setPassword(e.target.value); setError('') }}
                                        className="pl-10 pr-9"
                                        onKeyDown={e => { if (e.key === 'Enter' && emailValid && passwordValid) void handlePasswordSignIn() }}
                                    />
                                    <button
                                        type="button"
                                        data-theme-part="button"
                                        onClick={() => setShowPassword(s => !s)}
                                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                                    >
                                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </button>
                                </div>
                            </div>
                            <Button
                                size="sm"
                                className="h-8 w-full gap-1.5 text-xs"
                                onClick={() => void handlePasswordSignIn()}
                                disabled={busy || !emailValid || !passwordValid}
                            >
                                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                {busy ? 'Verifying...' : 'Sign in and connect'}
                            </Button>
                            <StremioSocialAuth
                                disabled={busy}
                                onAuthKey={(authKey, user) => { void claim(authKey, user?.email) }}
                                onError={message => setError(message)}
                            />
                        </TabsContent>
                        <TabsContent value="qr" className="space-y-3">
                            <p className="text-xs leading-relaxed text-muted-foreground">
                                Scan with your phone's Stremio app and approve to connect that account without typing its password here.
                            </p>
                            <Button
                                size="sm"
                                className="h-8 w-full gap-1.5 text-xs"
                                onClick={() => setQrOpen(true)}
                                disabled={busy}
                            >
                                <QrCode className="h-3.5 w-3.5" />
                                Connect with QR
                            </Button>
                        </TabsContent>
                        <TabsContent value="authkey" className="space-y-3">
                            <div className="space-y-2">
                                <Label htmlFor="stremio-setup-authkey">Auth Key</Label>
                                <div className="relative">
                                    <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        id="stremio-setup-authkey"
                                        type="password"
                                        placeholder="Paste a Stremio auth key"
                                        value={authKeyInput}
                                        onChange={e => { setAuthKeyInput(e.target.value); setError('') }}
                                        className="pl-10"
                                        onKeyDown={e => { if (e.key === 'Enter' && authKeyInput.trim()) void handleAuthKeySignIn() }}
                                    />
                                </div>
                            </div>
                            <Button
                                size="sm"
                                className="h-8 w-full gap-1.5 text-xs"
                                onClick={() => void handleAuthKeySignIn()}
                                disabled={busy || !authKeyInput.trim()}
                            >
                                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Key className="h-3.5 w-3.5" />}
                                {busy ? 'Verifying...' : 'Verify and connect'}
                            </Button>
                        </TabsContent>
                    </Tabs>
                    {error && (
                        <div data-theme-tone="status" data-theme-part="panel" className="rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
                            {error}
                        </div>
                    )}
                    {onBackToPicker && (
                        <DialogFooter>
                            <Button variant="outline" disabled={busy} onClick={onBackToPicker}>Back to connection picker</Button>
                        </DialogFooter>
                    )}
                </DialogContent>
            </Dialog>
            <QRLinkDialog
                open={qrOpen}
                onOpenChange={setQrOpen}
                title="Connect a Stremio login"
                description="Scan the QR code with your phone's Stremio app and approve to connect that account."
                start={createStremioLink}
                poll={pollStremioLink}
                onClaimed={handleQrClaimed}
            />
        </>
    )
}
