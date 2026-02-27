import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAccounts } from '@/hooks/useAccounts'
import { useUIStore } from '@/store/uiStore'
import {
  AlertCircle,
  ExternalLink,
  HelpCircle,
  Rocket,
  RefreshCw,
  Smile,
  Search,
  ShieldCheck,
  MoreVertical
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useAuthStore } from '@/store/authStore'
import { StremioOAuth } from './StremioOAuth'
import { ACCOUNT_COLORS } from '@/lib/utils'
import { EMOJI_GROUPS } from '@/lib/emoji-data'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { motion, AnimatePresence } from 'framer-motion'

export function AccountForm() {
  const isOpen = useUIStore((state) => state.isAddAccountDialogOpen)
  const closeDialog = useUIStore((state) => state.closeAddAccountDialog)
  const editingAccount = useUIStore((state) => state.editingAccount)
  const encryptionKey = useAuthStore((state) => state.encryptionKey)
  const { addAccountByAuthKey, addAccountByCredentials, updateAccount, loading } = useAccounts()

  const [mode, setMode] = useState<'authKey' | 'credentials' | 'oauth'>('credentials')
  const [name, setName] = useState('')
  const [authKey, setAuthKey] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [showHelp, setShowHelp] = useState(false)
  const [accentColor, setAccentColor] = useState<string | undefined>(undefined)
  const [emoji, setEmoji] = useState('')
  const [emojiSearch, setEmojiSearch] = useState('')

  useEffect(() => {
    if (editingAccount) {
      setName(editingAccount.name)
      if (editingAccount.email) {
        setMode('credentials')
        setEmail(editingAccount.email)
        // We can't decrypt the password to show it, but we can set a placeholder or just leave it blank
        // For simplicity in update, we leave it blank. If they enter content, we update it.
        setAccentColor(editingAccount.accentColor)
        setEmoji(editingAccount.emoji || '')
      } else {
        setMode('authKey')
        setAccentColor(editingAccount.accentColor)
        setEmoji(editingAccount.emoji || '')
        // Don't show existing auth key for security
        setAuthKey('')
      }
    } else {
      // Reset defaults for add mode
      setMode('credentials')
      setName('')
      setAuthKey('')
      setEmail('')
      setPassword('')
      setError('')
      setAccentColor(undefined)
      setEmoji('')
    }
  }, [editingAccount, isOpen])

  const handleClose = () => {
    closeDialog()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    if (e) {
      e.preventDefault()
      e.stopPropagation()
    }

    if (mode === 'oauth') return
    setError('')

    if (!encryptionKey) {
      setError('Your vault is locked. Please refresh or unlock the app with your master password.')
      return
    }

    try {
      if (editingAccount) {
        // Update mode
        await updateAccount(editingAccount.id, {
          name: name.trim(),
          // Only pass auth details if they are provided/changed
          authKey: mode === 'authKey' && authKey ? authKey.trim() : undefined,
          // When password is provided, always pass email too (even if unchanged)
          email:
            mode === 'credentials' && (password || email !== editingAccount.email)
              ? email.trim() || editingAccount.email
              : undefined,
          password: mode === 'credentials' && password ? password : undefined,
          accentColor: accentColor === 'none' ? undefined : accentColor,
          emoji: emoji.trim() || undefined,
        })
      } else {
        // Add mode
        if (mode === 'authKey') {
          if (!authKey.trim()) {
            setError('Auth key is required')
            return
          }
          await addAccountByAuthKey(authKey.trim(), name.trim() || 'My Account', accentColor === 'none' ? undefined : accentColor, emoji.trim() || undefined)
        } else if (mode === 'credentials') {
          if (!email.trim() || !password.trim()) {
            setError('Email and password are required')
            return
          }
          await addAccountByCredentials(email.trim(), password, name.trim() || email.trim(), accentColor === 'none' ? undefined : accentColor, emoji.trim() || undefined)
        }
      }
      handleClose()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Failed to ${editingAccount ? 'update' : 'add'} account`
      )
    }
  }

  const isEditing = !!editingAccount

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Account' : 'Add Stremio Account'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update account details. Leave credentials blank to keep them unchanged.'
              : 'Add an account using either your auth key or email and password'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="mt-4">
          <Tabs defaultValue="account" className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-6 bg-muted/20 p-1 h-11 rounded-full border border-white/5">
              <TabsTrigger value="account" className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-all h-9 font-bold">
                Account
              </TabsTrigger>
              <TabsTrigger value="customize" className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-all h-9 font-bold">
                Customize
              </TabsTrigger>
            </TabsList>

            <TabsContent value="account" className="space-y-4 animate-in fade-in slide-in-from-left-2 duration-300">
              {!isEditing && (
                <div className="flex gap-2 border-b border-white/5 pb-3">
                  <Button
                    type="button"
                    variant={mode === 'credentials' ? 'default' : 'ghost'}
                    size="sm"
                    className="rounded-full px-4 h-8 text-[11px] font-bold uppercase tracking-wider"
                    onClick={() => {
                      setMode('credentials')
                      setError('')
                    }}
                  >
                    Email & Password
                  </Button>
                  <Button
                    type="button"
                    variant={mode === 'oauth' ? 'default' : 'ghost'}
                    size="sm"
                    className="rounded-full px-4 h-8 text-[11px] font-bold uppercase tracking-wider"
                    onClick={() => {
                      setMode('oauth')
                      setError('')
                    }}
                  >
                    OAuth
                  </Button>
                  <Button
                    type="button"
                    variant={mode === 'authKey' ? 'default' : 'ghost'}
                    size="sm"
                    className="rounded-full px-4 h-8 text-[11px] font-bold uppercase tracking-wider"
                    onClick={() => {
                      setMode('authKey')
                      setError('')
                    }}
                  >
                    Auth Key
                  </Button>
                </div>
              )}

              {!isEditing && mode === 'credentials' && (
                <div className="bg-primary/5 border border-primary/20 p-4 rounded-xl space-y-3">
                  <div className="flex items-center gap-2 text-primary font-semibold text-sm">
                    <Rocket className="h-4 w-4" />
                    <span>Smart Integration Highlights</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    <div className="flex items-start gap-3">
                      <div className="mt-1 bg-primary/10 p-1.5 rounded-lg text-primary">
                        <RefreshCw className="h-3 w-3" />
                      </div>
                      <div>
                        <h4 className="text-xs font-bold">Auto-Registration</h4>
                        <p className="text-[10px] text-muted-foreground leading-tight">
                          Login with any email—if the Stremio account doesn't exist, we'll create it
                          instantly for you. ✨
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="name" className="text-xs font-bold uppercase tracking-widest opacity-60">Display Name (optional)</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Account"
                  className="bg-background/50 border-muted focus:bg-background transition-colors h-11"
                />
              </div>

              {mode === 'oauth' ? (
                <StremioOAuth
                  onAuthKey={async (key) => {
                    setAuthKey(key)
                    if (!isEditing) {
                      try {
                        await addAccountByAuthKey(key, name.trim())
                        handleClose()
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Failed to add account')
                      }
                    }
                  }}
                  onError={setError}
                  disabled={loading}
                />
              ) : mode === 'authKey' ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="authKey" className="text-xs font-bold uppercase tracking-widest opacity-60">Auth Key</Label>
                    <Input
                      id="authKey"
                      type="password"
                      value={authKey}
                      onChange={(e) => setAuthKey(e.target.value)}
                      placeholder={isEditing ? '••••• (encrypted)' : 'Enter your Stremio auth key'}
                      required={!isEditing}
                      className="bg-background/50 border-muted focus:bg-background transition-colors h-11"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setShowHelp(!showHelp)}
                      className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
                    >
                      <HelpCircle className="h-3.5 w-3.5" />
                      {showHelp ? 'Hide instructions' : 'Where to find?'}
                    </button>
                    <Link
                      to="/faq#account-setup"
                      onClick={handleClose}
                      className="text-[10px] text-muted-foreground hover:text-primary flex items-center gap-1"
                    >
                      Full Guide <ExternalLink className="h-2.5 w-2.5" />
                    </Link>
                  </div>

                  <AnimatePresence>
                    {showHelp && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="p-3 bg-muted/50 rounded-xl border border-white/5 space-y-3 mt-1">
                          <div className="space-y-2">
                            <p className="text-[11px] leading-relaxed text-muted-foreground">
                              1. Log into <a href="https://web.stremio.com/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline italic">web.stremio.com</a>
                            </p>
                            <p className="text-[11px] leading-relaxed text-muted-foreground">
                              2. Run in Console (<kbd className="px-1 py-0.5 rounded bg-black/40 border border-white/10 text-[9px]">F12</kbd>):
                            </p>
                            <pre
                              className="text-[10px] bg-black/40 p-2 rounded border border-white/10 font-mono text-zinc-300 select-all cursor-pointer hover:bg-black/60 transition-colors"
                              onClick={(e) => {
                                const target = e.currentTarget
                                const selection = window.getSelection()
                                const range = document.createRange()
                                range.selectNodeContents(target)
                                selection?.removeAllRanges()
                                selection?.addRange(range)
                              }}
                            >
                              localStorage.getItem("profile")
                            </pre>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-xs font-bold uppercase tracking-widest opacity-60">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="your@email.com"
                      required={!isEditing}
                      className="bg-background/50 border-muted focus:bg-background transition-colors h-11"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="password" className="text-xs font-bold uppercase tracking-widest opacity-60">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      autoComplete={isEditing ? 'new-password' : 'current-password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={isEditing ? 'Leave blank to keep unchanged' : 'Enter your password'}
                      required={!isEditing}
                      className="bg-background/50 border-muted focus:bg-background transition-colors h-11"
                    />
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="customize" className="space-y-6 animate-in fade-in slide-in-from-right-2 duration-300">
              {/* Live Preview */}
              <div className="space-y-2">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground opacity-60">Card Preview</p>
                <Card
                  className="transition-all duration-300 shadow-sm pointer-events-none border-white/5"
                  style={{ borderLeft: (accentColor && accentColor !== 'none') ? `3px solid ${accentColor}` : undefined }}
                >
                  <CardHeader className="relative pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4 flex-1 min-w-0">
                        <div className="flex-1 min-w-0">
                          <CardTitle className="flex items-center gap-2 text-lg font-semibold truncate tracking-tight">
                            <span className="w-2 h-2 rounded-full flex-shrink-0 bg-green-500" title="Active" />
                            {emoji && <span className="text-xl mr-0.5">{emoji}</span>}
                            <span className="truncate flex-1">
                              {name || (email ? email.split('@')[0] : 'My Account')}
                            </span>
                          </CardTitle>
                          {email && (
                            <p className="text-sm text-muted-foreground mt-1 truncate">
                              {email}
                            </p>
                          )}
                        </div>
                        <Button variant="ghost" className="h-8 w-8 p-0 opacity-20">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="text-muted-foreground">Addons:</span>
                        <span className="font-medium">{loading ? '—' : isEditing ? editingAccount?.addons.length || 0 : 0}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-sm">
                        <ShieldCheck className="w-3.5 h-3.5 text-green-500" />
                        <span className="text-green-600 dark:text-green-400 font-medium truncate">
                          Healthy
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="text-muted-foreground">Synced 2m ago</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <div className="space-y-4 px-1">
                <div className="space-y-3">
                  <Label className="text-xs font-bold uppercase tracking-widest opacity-60">Account Emoji</Label>
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <Input
                        id="emoji"
                        value={emoji}
                        onChange={(e) => setEmoji(e.target.value)}
                        placeholder="👤"
                        className="bg-background/50 border-muted focus:bg-background transition-colors w-14 h-14 text-center text-2xl p-0 rounded-2xl shadow-inner"
                        maxLength={4}
                      />
                    </div>

                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="icon" className="h-14 w-14 rounded-2xl bg-background/50 border-muted hover:bg-muted/50 hover:scale-105 active:scale-95 transition-all shadow-sm">
                          <Smile className="h-6 w-6 opacity-60" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[320px] p-0 border-white/5 shadow-2xl overflow-hidden rounded-2xl" align="start">
                        <div className="flex flex-col h-[380px] bg-popover/95 backdrop-blur-xl">
                          <div className="p-3 border-b border-white/5 bg-muted/20">
                            <div className="relative">
                              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                              <Input
                                placeholder="Search emojis..."
                                className="pl-9 h-9 text-xs bg-background/50 border-muted focus:bg-background rounded-lg"
                                value={emojiSearch}
                                onChange={(e) => setEmojiSearch(e.target.value)}
                                autoFocus
                              />
                            </div>
                          </div>

                          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                            {Object.entries(EMOJI_GROUPS).map(([group, emojis]) => {
                              const filtered = emojis.filter(e =>
                                e.keywords.some(k => k.toLowerCase().includes(emojiSearch.toLowerCase())) ||
                                e.char.includes(emojiSearch)
                              )
                              if (filtered.length === 0) return null

                              return (
                                <div key={group} className="mb-6 last:mb-0">
                                  <h4 className="text-[9px] font-black uppercase tracking-[0.2em] text-primary/60 mb-3 px-1">{group}</h4>
                                  <div className="grid grid-cols-6 gap-2">
                                    {filtered.map((e) => (
                                      <button
                                        key={e.char}
                                        type="button"
                                        onClick={() => setEmoji(e.char)}
                                        className={`h-10 w-10 flex items-center justify-center text-xl rounded-xl transition-all duration-200 hover:scale-115 hover:bg-primary/20 ${emoji === e.char ? 'bg-primary/25 ring-2 ring-primary shadow-lg scale-110' : 'hover:bg-accent/40'}`}
                                        title={e.keywords[0]}
                                      >
                                        {e.char}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-14 px-4 text-[10px] font-bold uppercase rounded-2xl opacity-40 hover:opacity-100 hover:text-destructive hover:bg-destructive/5 transition-all"
                      onClick={() => setEmoji('')}
                    >
                      Clear
                    </Button>
                  </div>
                </div>

                <div className="space-y-4">
                  <Label className="text-xs font-bold uppercase tracking-widest opacity-60">Theme Color</Label>

                  <div className="bg-muted/10 p-4 rounded-2xl border border-white/5 space-y-5">
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        key="none"
                        type="button"
                        onClick={() => setAccentColor('none')}
                        className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all hover:scale-110 relative overflow-hidden group ${accentColor === 'none' ? 'ring-2 ring-white ring-offset-2 ring-offset-background' : 'border border-white/20'}`}
                        title="No accent color"
                      >
                        <div className="absolute inset-x-0 h-0.5 bg-red-500/50 rotate-45" />
                        <div className="text-[10px] font-bold opacity-40 group-hover:opacity-100 transition-opacity">Off</div>
                      </button>

                      {ACCOUNT_COLORS.map((hex) => (
                        <button
                          key={hex}
                          type="button"
                          onClick={() => setAccentColor(hex)}
                          className={`w-8 h-8 rounded-xl transition-all hover:scale-115 ${accentColor === hex ? 'ring-2 ring-white ring-offset-2 ring-offset-background shadow-lg' : ''}`}
                          style={{ backgroundColor: hex }}
                        />
                      ))}

                      <div className="relative w-8 h-8">
                        <button
                          type="button"
                          onClick={() => document.getElementById('custom-color-input')?.click()}
                          className={`w-8 h-8 rounded-xl transition-all hover:scale-115 bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] ${(accentColor && accentColor !== 'none' && !ACCOUNT_COLORS.includes(accentColor)) ? 'ring-2 ring-white ring-offset-2 ring-offset-background shadow-lg' : ''}`}
                          title="Custom color"
                        />
                        <input
                          id="custom-color-input"
                          type="color"
                          value={accentColor && accentColor.startsWith('#') ? accentColor : '#6366f1'}
                          onChange={(e) => setAccentColor(e.target.value)}
                          className="absolute opacity-0 w-1 h-1 pointer-events-none"
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <div
                        className="w-10 h-10 rounded-xl shadow-inner border border-white/10 shrink-0 transition-colors duration-500"
                        style={{ background: (accentColor && accentColor !== 'none') ? accentColor : 'transparent' }}
                      />
                      <div className="relative flex-1">
                        <Input
                          type="text"
                          value={accentColor === 'none' ? '' : (accentColor || '')}
                          onChange={(e) => {
                            const val = e.target.value
                            if (/^#[0-9a-fA-F]{0,6}$/.test(val)) setAccentColor(val)
                          }}
                          placeholder={accentColor === 'none' ? 'None' : "#hexcode"}
                          className="font-mono text-xs bg-background/50 border-muted focus:bg-background h-10 rounded-xl"
                          disabled={accentColor === 'none'}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {error && (
            <div className="bg-destructive/10 border border-destructive/50 rounded-xl px-4 py-3 mt-6 animate-in shake duration-500">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-bold text-destructive">{error}</p>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="mt-8 border-t border-white/5 pt-6">
            <Button type="button" variant="ghost" onClick={handleClose} className="rounded-xl font-bold uppercase tracking-wider text-xs">
              Cancel
            </Button>
            {mode !== 'oauth' && (
              <Button
                type="submit"
                disabled={loading || !encryptionKey}
                className="rounded-xl font-black uppercase tracking-widest text-xs px-8 shadow-xl hover:shadow-primary/20 transition-all hover:scale-105"
              >
                {loading
                  ? isEditing ? 'Updating...' : 'Adding...'
                  : !encryptionKey ? 'Vault Locked' : isEditing ? 'Save Changes' : 'Create Account'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
