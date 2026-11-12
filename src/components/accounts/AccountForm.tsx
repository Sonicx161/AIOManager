import { Button } from '@/components/ui/button'
import { ImageUploadButton } from '@/components/ui/image-upload-button'
import { Tooltip } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogBack,
  DialogAltHistory,
  useDrillHistory,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useAccounts } from '@/hooks/useAccounts'
import { useUIStore } from '@/store/uiStore'
import { useAccountStore, hasPlatformConnection, getStremioConnection } from '@/store/accountStore'
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  HelpCircle,
  KeyRound,
  Mail,
  Play,
  QrCode,
  Search,
  ShieldCheck,
  Smile,
  X,
  type LucideIcon
} from 'lucide-react'
import { Suspense, lazy, useEffect, useMemo, useState, useRef } from 'react'
import { AddonPreviewTile } from './AddonPreviewTile'
import { Link } from 'react-router-dom'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useAuthStore } from '@/store/authStore'
import { StremioOAuth } from './StremioOAuth'
import { QRLinkDialog } from '@/components/qr/QRLinkDialog'
import type { QRSession } from '@/lib/qr-device-link'
import { createStremioLink, pollStremioLink } from '@/api/stremio-link'
import { buildResetPasswordUrl } from '@/api/stremio-relay'
import { StremioSocialAuth } from './StremioSocialAuth'
import { NuvioSetupDialog, type NuvioBackend } from '@/components/providers/NuvioSetupDialog'
import { RealStreamSetupDialog, type RealStreamTokens } from '@/components/providers/RealStreamSetupDialog'
import { JellyfinSetupDialog } from '@/components/providers/JellyfinSetupDialog'
import type { JellyfinSession } from '@/lib/jellyfin/session'
import { sealJellyfinSecret } from '@/lib/jellyfin/connection-data'
import { encrypt } from '@/lib/crypto'
import { ProviderSetupDialog } from '@/components/providers/ProviderSetupDialog'
import { useConnectionStore } from '@/store/connectionStore'
import type { HydraDriverConfig } from '@/types/provider'
import { ACCOUNT_COLORS, cn, getTimeAgo } from '@/lib/utils'
import { EMOJI_GROUPS } from '@/lib/emoji-data'
import { useShallow } from 'zustand/react/shallow'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useLibraryCache } from '@/store/libraryCache'
import { activityForAccount } from '@/lib/account-activity-index'
import { useJellyfinActivity } from '@/hooks/useJellyfinActivity'
import { accountMediaPlayback, mergeMediaItems } from '@/lib/jellyfin/activity'
import { AccountMediaPlayback } from './AccountMedia'
import { aggregateAccountPlatforms, accountPlatformSources } from '@/components/addons/platform-source'
import { toast } from '@/hooks/use-toast'
import { formatFileSize, processImageFile } from '@/lib/image-upload'
import type { ActivityItem } from '@/types/activity'
import type { Account } from '@/types/account'
import { cardVisibilitySummary, activeConnectionsLabel } from './profile-sheet'
import { ColorPicker } from '@/components/ui/color-picker'
const ConnectionManager = lazy(() =>
  import('@/components/providers/ConnectionManager').then((m) => ({ default: m.ConnectionManager }))
)
const preloadConnectionManager = () => { void import('@/components/providers/ConnectionManager') }
import { useTheme } from '@/contexts/ThemeContext'
import { motion, AnimatePresence } from 'framer-motion'
import { PLATFORM_REGISTRY, getPlatformEntry } from '@/lib/platform-registry'
import { AccountAvatar } from './AccountAvatar'
import { ConnectionPicturesSection } from './ConnectionPicturesSection'
import { StremioPasswordResetPanel } from './StremioPasswordResetPanel'
import { isStremioPasswordResetError } from '@/lib/stremio-password-reset'
import { useMaskedAccountLabel } from '@/hooks/useMaskedAccountLabel'

type AccountAuthMode = 'credentials' | 'oauth' | 'authKey' | 'qr'
type WizardStep = 'identity' | 'platform' | 'connect-more'
type PlatformStep = 'select' | 'stremio-auth'

const ACCOUNT_AUTH_METHODS: Array<{ id: AccountAuthMode; label: string; subtitle: string; icon: LucideIcon }> = [
  { id: 'credentials', label: 'Email & Password', subtitle: 'Best for persistent sync and auto-refresh.', icon: Mail },
  { id: 'oauth', label: 'OAuth', subtitle: 'Approve in Stremio without typing your password here.', icon: ShieldCheck },
  { id: 'qr', label: 'QR Code', subtitle: "Scan with your phone's Stremio app.", icon: QrCode },
  { id: 'authKey', label: 'Auth Key', subtitle: 'Paste an existing token for advanced imports.', icon: KeyRound },
]

export function AccountForm() {
  const isOpen = useUIStore((state) => state.isAddAccountDialogOpen)
  const closeDialog = useUIStore((state) => state.closeAddAccountDialog)
  const editingAccount = useUIStore((state) => state.editingAccount)
  const focusConnectionId = useUIStore((state) => state.addAccountFocusConnectionId)
  // Closing clears editingAccount at once while the sheet is still fading out; hold it so the sheet does not swap to the add flow.
  const [closingAccount, setClosingAccount] = useState<Account | null>(null)
  const closingTimerRef = useRef<number | null>(null)
  const editTarget = editingAccount ?? closingAccount
  const liveAccount = useAccountStore((s) => editTarget ? s.accounts.find(a => a.id === editTarget.id) ?? editTarget : null)
  const encryptionKey = useAuthStore((state) => state.encryptionKey)
  const { addAccountByAuthKey, addAccountByCredentials, addLocalAccount, removeAccount, updateAccount, loading } = useAccounts()
  const { isLight } = useTheme()

  const [wizardStep, setWizardStep] = useState<WizardStep>('identity')
  const [platformStep, setPlatformStep] = useState<PlatformStep>('select')
  const [createdAccountId, setCreatedAccountId] = useState<string | null>(null)
  const [connectedPlatforms, setConnectedPlatforms] = useState<Set<string>>(new Set())
  const [nuvioDialogOpen, setNuvioDialogOpen] = useState(false)
  const [qrDialogOpen, setQrDialogOpen] = useState(false)
  const [realstreamDialogOpen, setRealstreamDialogOpen] = useState(false)
  const [jellyfinDialogOpen, setJellyfinDialogOpen] = useState(false)
  const [hydraDialogOpen, setHydraDialogOpen] = useState(false)
  const [mode, setMode] = useState<AccountAuthMode>('credentials')
  const [authIntent, setAuthIntent] = useState<'login' | 'signup'>('login')
  const [name, setName] = useState('')
  const [authKey, setAuthKey] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [oauthAuthKey, setOauthAuthKey] = useState('')
  const [oauthEmail, setOauthEmail] = useState('')
  const [oauthPassword, setOauthPassword] = useState('')
  const [oauthSaving, setOauthSaving] = useState(false)
  const [oauthEmailLoading, setOauthEmailLoading] = useState(false)
  const [error, setError] = useState('')
  const [showHelp, setShowHelp] = useState(false)
  const [accentColor, setAccentColor] = useState<string | undefined>(undefined)
  const [emoji, setEmoji] = useState('')
  const [emojiSearch, setEmojiSearch] = useState('')
  const [avatar, setAvatar] = useState('')
  // A large GIF is resized in a worker; Done waits for it so the new picture is never dropped.
  const [avatarProcessing, setAvatarProcessing] = useState(false)
  const [hideLastWatched, setHideLastWatched] = useState(false)
  const [hideAddonPreview, setHideAddonPreview] = useState(false)
  const [hidePlatformLogos, setHidePlatformLogos] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Edit-page history with the shared back/forward model (profile <-> connections);
  // transitions pull focus back to the sheet through the hook's containerRef.
  const editSheetRef = useRef<HTMLDivElement>(null)
  const { page: editPage, canBack: editCanBack, canForward: editCanForward, go: setEditPage, back: editPageBack, goForward: editPageForward, reset: resetEditPage } = useDrillHistory<'profile' | 'connections'>('profile', { containerRef: editSheetRef })
  const isEditing = !!editTarget
  const [colorOpen, setColorOpen] = useState(false)
  const [cardOpen, setCardOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [showAvatarUrl, setShowAvatarUrl] = useState(false)
  const avatarFileInputRef = useRef<HTMLInputElement>(null)
  const [signInAgainTarget, setSignInAgainTarget] = useState<{ id: string; nonce: number } | null>(null)
  const maskedAccountLabel = useMaskedAccountLabel()

  // Draft-aware dashboard card preview: the same read-only activity sources the real
  // AccountCard reads, hoisted here so the add flow never polls them.
  const previewAccountId = editTarget?.id
  const previewCachedItems = useLibraryCache(useShallow((state) => previewAccountId ? activityForAccount(state.items, previewAccountId) : []))
  const previewMedia = useJellyfinActivity(previewAccountId, !!previewAccountId, { archive: false })
  const previewItems = useMemo(
    () => previewAccountId ? mergeMediaItems(previewCachedItems, previewMedia.history) : [],
    [previewAccountId, previewCachedItems, previewMedia.history]
  )
  const previewLastWatched = useMemo((): ActivityItem | null => {
    if (!previewAccountId || previewItems.length === 0) return null
    return previewItems.reduce<ActivityItem>(
      (max, item) => new Date(item.timestamp).getTime() > new Date(max.timestamp).getTime() ? item : max,
      previewItems[0]
    )
  }, [previewAccountId, previewItems])

  const isExpiredSession = editTarget?.status === 'expired'
  const expiredSessionConnection = editTarget?.connections?.find(c => c.enabled !== false && c.status === 'expired')
  const expiredSessionPlatformName = expiredSessionConnection
    ? getPlatformEntry(expiredSessionConnection.platform)?.name || expiredSessionConnection.platform
    : editTarget && hasPlatformConnection(editTarget) ? 'Stremio' : 'Account'

  useEffect(() => {
    if (!isOpen) return
    setClosingAccount(null)
    setOauthAuthKey('')
    setOauthEmail('')
    setOauthPassword('')
    setOauthSaving(false)
    setOauthEmailLoading(false)
    setError('')
    setShowHelp(false)
    setWizardStep('identity')
    setPlatformStep('select')
    setCreatedAccountId(null)
    setConnectedPlatforms(new Set())
    // An expired account opens on Connections with Profile below it, so Back and
    // Escape still work; everything else starts on Profile. A requested sign-in
    // (sync failure fix button) also lands on Connections, focused on that
    // connection's own sign-in sheet.
    resetEditPage(editingAccount?.status === 'expired' || (editingAccount && focusConnectionId) ? ['profile', 'connections'] : 'profile')
    if (editingAccount?.status === 'expired' || (editingAccount && focusConnectionId)) preloadConnectionManager()
    setColorOpen(false)
    setCardOpen(false)
    setEmojiOpen(false)
    setShowAvatarUrl(false)
    setSignInAgainTarget(editingAccount && focusConnectionId ? { id: focusConnectionId, nonce: Date.now() } : null)
    setSubmitting(false)

    if (editingAccount) {
      setName(editingAccount.name)
      setAuthKey('')
      setPassword('')
      // Canonical resolution (primary-pointed Stremio login, else first stored, else the
      // legacy authKey synth): with several logins bound, the edit dialog's defaults must
      // describe the CANONICAL one, not whichever login happens to be stored first.
      const stremioConn = getStremioConnection(editingAccount)
      const connEmail = stremioConn?.credentials?.email
      const connAuthKey = stremioConn?.credentials?.authKey
      if (connEmail) {
        setMode('credentials')
        setEmail(connEmail)
      } else if (connAuthKey) {
        setMode('authKey')
        setEmail('')
        setAuthKey('')
      } else {
        setMode('credentials')
        setEmail('')
        setAuthKey('')
      }
      setAccentColor(editingAccount.accentColor)
      setEmoji(editingAccount.emoji || '')
      setAvatar(editingAccount.avatar || '')
      setHideLastWatched(editingAccount.hideLastWatched ?? false)
      setHideAddonPreview(editingAccount.hideAddonPreview ?? false)
      setHidePlatformLogos(editingAccount.hidePlatformLogos ?? false)
    } else {
      setMode('credentials')
      setAuthIntent('login')
      setName('')
      setAuthKey('')
      setEmail('')
      setPassword('')
      setAccentColor(undefined)
      setEmoji('')
      setAvatar('')
      setHideLastWatched(false)
    }
  }, [editingAccount, isOpen, focusConnectionId, resetEditPage])

  useEffect(() => () => {
    if (closingTimerRef.current !== null) window.clearTimeout(closingTimerRef.current)
  }, [])

  const handleClose = () => {
    setClosingAccount(editingAccount)
    if (closingTimerRef.current !== null) window.clearTimeout(closingTimerRef.current)
    closingTimerRef.current = window.setTimeout(() => {
      closingTimerRef.current = null
      setClosingAccount(null)
    }, 320)
    setCreatedAccountId(null)
    setConnectedPlatforms(new Set())
    closeDialog()
  }

  const handleAvatarFile = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) {
      toast({ variant: 'destructive', title: 'File too large', description: `Max 8 MB, got ${formatFileSize(file.size)}.` })
      return
    }
    setAvatarProcessing(true)
    try {
      const result = await processImageFile(file, { maxDimension: 256, square: true, quality: 0.85 })
      setAvatar(result.dataUrl)
      toast({ title: 'Image uploaded', description: `${formatFileSize(result.size)} ${result.mime.split('/')[1].toUpperCase()}` })
    } catch (err) {
      toast({ variant: 'destructive', title: 'Upload failed', description: err instanceof Error ? err.message : 'Unknown error.' })
    } finally {
      setAvatarProcessing(false)
    }
  }

  const handleOAuthApproved = (key: string, user?: { email?: string; username?: string; name?: string }) => {
    const providedEmail = user?.email?.trim() || ''
    setAuthKey(key)
    setOauthAuthKey(key)
    setOauthPassword('')
    setOauthEmailLoading(false)
    setError('')

    if (providedEmail) {
      setOauthEmail(providedEmail)
      setEmail(providedEmail)
      setName(current => current.trim() ? current : providedEmail)
      return
    }

    const fallbackEmail = email.trim()
    setOauthEmail(fallbackEmail)
    setOauthEmailLoading(!fallbackEmail)
    void (async () => {
      try {
        const { stremioClient } = await import('@/api/stremio-client')
        const stremioUser = await stremioClient.getUser(key)
        const detectedEmail = stremioUser.email?.trim()
        if (!detectedEmail) return
        setOauthEmail(current => current.trim() ? current : detectedEmail)
        setEmail(current => current.trim() ? current : detectedEmail)
        setName(current => current.trim() ? current : detectedEmail)
      } catch (err) {
        if (import.meta.env.DEV) console.warn('[AccountForm] Could not prefill OAuth email:', err)
      } finally {
        setOauthEmailLoading(false)
      }
    })()
  }

  const handleSaveOAuthAccount = async (persistent: boolean) => {
    if (!oauthAuthKey) {
      setError('Complete OAuth authorization first.')
      return
    }
    if (!encryptionKey) {
      setError('Session expired. Sign in again before saving accounts.')
      return
    }

    setOauthSaving(true)
    setError('')
    try {
      const beforeIds = !editingAccount ? new Set(useAccountStore.getState().accounts.map(a => a.id)) : null
      if (persistent) {
        const resolvedEmail = (oauthEmail || email || editingAccount?.email || '').trim()
        if (!resolvedEmail || !oauthPassword.trim()) {
          setError('Enter the Stremio email and password to make this OAuth account persistent.')
          return
        }
        if (editingAccount) {
          await updateAccount(editingAccount.id, {
            name: name.trim() || resolvedEmail,
            email: resolvedEmail,
            password: oauthPassword,
            accentColor: accentColor === 'none' ? undefined : accentColor,
            emoji: emoji.trim() || undefined,
            avatar: avatar || undefined,
            hideLastWatched,
            hideAddonPreview,
            hidePlatformLogos,
          })
        } else {
          await addAccountByCredentials(
            resolvedEmail,
            oauthPassword,
            name.trim() || resolvedEmail,
            accentColor === 'none' ? undefined : accentColor,
            emoji.trim() || undefined,
            avatar || undefined,
            'login'
          )
        }
      } else {
        if (editingAccount) {
          await updateAccount(editingAccount.id, {
            name: name.trim() || oauthEmail || editingAccount.name || 'Account',
            authKey: oauthAuthKey,
            accentColor: accentColor === 'none' ? undefined : accentColor,
            emoji: emoji.trim() || undefined,
            avatar: avatar || undefined,
            hideLastWatched,
            hideAddonPreview,
            hidePlatformLogos,
          })
        } else {
          await addAccountByAuthKey(
            oauthAuthKey,
            name.trim() || oauthEmail || 'Account',
            accentColor === 'none' ? undefined : accentColor,
            emoji.trim() || undefined,
            avatar || undefined
          )
        }
      }
      if (editingAccount) {
        handleClose()
      } else if (beforeIds) {
        const newAccount = useAccountStore.getState().accounts.find(a => !beforeIds.has(a.id))
        if (newAccount) {
          setCreatedAccountId(newAccount.id)
          setConnectedPlatforms(prev => new Set(prev).add('stremio'))
          setWizardStep('connect-more')
        } else {
          handleClose()
        }
      } else {
        handleClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${editingAccount ? 'update' : 'add'} account`)
    } finally {
      setOauthSaving(false)
    }
  }

  const handleIdentityNext = () => {
    if (!name.trim()) {
      setError('Give your account a name.')
      return
    }
    setError('')
    setWizardStep('platform')
  }

  const handleSkipLocal = async () => {
    if (!name.trim()) {
      setError('Give your account a name.')
      return
    }
    setError('')
    setSubmitting(true)
    try {
      await addLocalAccount(name.trim(), accentColor === 'none' ? undefined : accentColor, emoji.trim() || undefined, avatar || undefined)
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create account')
    } finally {
      setSubmitting(false)
    }
  }

  const handleNuvioAccountComplete = async (
    tokens: { accessToken: string; refreshToken: string; expiresAt: number },
    profileId: string | null,
    _profiles: unknown[],
    email: string,
    backend: NuvioBackend
  ) => {
    let accountId: string | undefined
    const isFirstConnection = !createdAccountId
    try {
      if (isFirstConnection) {
        accountId = await addLocalAccount(name.trim() || 'Nuvio Account', accentColor === 'none' ? undefined : accentColor, emoji.trim() || undefined, avatar || undefined)
        setCreatedAccountId(accountId)
      } else {
        accountId = createdAccountId
      }
      const profileIndex = (() => {
        if (!profileId) return ''
        const match = (_profiles as Array<Record<string, unknown>>).find(p => p?.id === profileId)
        const idx = match ? Number(match.profile_index ?? match.profileIndex) : NaN
        return Number.isFinite(idx) && idx > 0 ? String(idx) : ''
      })()
      await useConnectionStore.getState().addConnection(accountId, {
        platform: 'nuvio',
        driverType: 'native',
        connectionType: 'native',
        enabled: true,
        status: 'active',
        credentials: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: String(tokens.expiresAt),
          profileId: profileId || '',
          profileIndex,
          email,
          ...(backend?.baseUrl ? { baseUrl: backend.baseUrl } : {}),
          ...(backend?.publishableKey ? { publishableKey: backend.publishableKey } : {}),
        },
        capabilities: ['addons', 'plugins', 'profiles'],
      })
      const { scheduleSyncAccount } = await import('@/store/account/accountSync')
      scheduleSyncAccount(accountId, false, 'user')
      setConnectedPlatforms(prev => new Set(prev).add('nuvio'))
      if (isFirstConnection) {
        setWizardStep('connect-more')
      } else {
        setNuvioDialogOpen(false)
      }
    } catch (err) {
      if (isFirstConnection) {
        if (accountId) removeAccount(accountId).catch(() => {})
        setCreatedAccountId(null)
      }
      setError(err instanceof Error ? err.message : 'Failed to add Nuvio connection')
      throw err
    }
  }

  const handleJellyfinAccountComplete = async (session: JellyfinSession) => {
    const key = useAuthStore.getState().encryptionKey
    if (!key) throw new Error('Unlock your vault before saving a connection')
    const credentials = await sealJellyfinSecret(session.secret, value => encrypt(value, key))
    if (useAuthStore.getState().encryptionKey !== key) throw new Error('Your vault changed while saving. Unlock it and try again.')
    const accountId = createdAccountId || await addLocalAccount(name.trim() || 'Media Account', accentColor === 'none' ? undefined : accentColor, emoji.trim() || undefined, avatar || undefined)
    setCreatedAccountId(accountId)
    await useConnectionStore.getState().addConnection(accountId, {
      platform: 'jellyfin', connectionType: 'native', enabled: true, status: 'active',
      credentials, capabilities: [], mediaServer: session.identity, displayName: session.identity.productName,
    })
    setConnectedPlatforms(prev => new Set(prev).add('jellyfin'))
    setWizardStep('connect-more')
  }

  const handleRealStreamAccountComplete = async (tokens: RealStreamTokens, email: string, password: string) => {
    let accountId: string | undefined
    const isFirstConnection = !createdAccountId
    try {
      if (isFirstConnection) {
        accountId = await addLocalAccount(name.trim() || 'RealStream Account', accentColor === 'none' ? undefined : accentColor, emoji.trim() || undefined, avatar || undefined)
        setCreatedAccountId(accountId)
      } else {
        accountId = createdAccountId
      }
      await useConnectionStore.getState().addConnection(accountId, {
        platform: 'realstream',
        driverType: 'native',
        connectionType: 'native',
        enabled: true,
        status: 'active',
        credentials: {
          accessToken: tokens.accessToken,
          userId: tokens.userId || '',
          expiresAt: String(tokens.expiresAt),
          email,
          password,
        },
        capabilities: ['addons'],
      })
      const { scheduleSyncAccount } = await import('@/store/account/accountSync')
      scheduleSyncAccount(accountId, false, 'user')
      setConnectedPlatforms(prev => new Set(prev).add('realstream'))
      if (isFirstConnection) {
        setWizardStep('connect-more')
      } else {
        setRealstreamDialogOpen(false)
      }
    } catch (err) {
      if (isFirstConnection) {
        if (accountId) removeAccount(accountId).catch(() => {})
        setCreatedAccountId(null)
      }
      setError(err instanceof Error ? err.message : 'Failed to add RealStream connection')
      throw err
    }
  }

  const handleHydraAccountComplete = async (config: HydraDriverConfig, credential: string) => {
    let accountId: string | undefined
    const isFirstConnection = !createdAccountId
    try {
      if (isFirstConnection) {
        accountId = await addLocalAccount(name.trim() || config.name, accentColor === 'none' ? undefined : accentColor, emoji.trim() || undefined, avatar || undefined)
        setCreatedAccountId(accountId)
      } else {
        accountId = createdAccountId
      }
      await useConnectionStore.getState().addConnection(accountId, {
        platform: config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        driverType: 'hydra-outbound',
        connectionType: 'hydra-outbound',
        enabled: true,
        status: 'active',
        credentials: { apiKey: credential },
        capabilities: ['addons'],
        driverConfig: config,
      })
      setConnectedPlatforms(prev => new Set(prev).add('hydra-outbound'))
      if (isFirstConnection) {
        setWizardStep('connect-more')
      } else {
        setHydraDialogOpen(false)
      }
    } catch (err) {
      if (isFirstConnection) {
        if (accountId) removeAccount(accountId).catch(() => {})
        setCreatedAccountId(null)
      }
      setError(err instanceof Error ? err.message : 'Failed to add Hydra connection')
      throw err
    }
  }

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault()
      e.stopPropagation()
    }

    if (mode === 'oauth' || mode === 'qr') return
    // Enter-to-submit must not save past a picture that is still being resized.
    if (avatarProcessing) return
    setError('')

    if (!encryptionKey) {
      setError('Session expired. Sign in again before saving accounts.')
      return
    }

    if (editingAccount) {
      const resolvedEmail = email.trim() || editingAccount.email || ''
      if (mode === 'credentials' && password.trim() && !resolvedEmail) {
        setError('Email is required when updating Stremio credentials.')
        return
      }
    }

    setSubmitting(true)
    try {
      const beforeIds = !editingAccount ? new Set(useAccountStore.getState().accounts.map(a => a.id)) : null
      if (editingAccount) {
        await updateAccount(editingAccount.id, {
          name: name.trim() || editingAccount.name,
          authKey: mode === 'authKey' && authKey.trim() ? authKey.trim() : undefined,
          email:
            mode === 'credentials' && (password.trim() || email !== editingAccount.email)
              ? email.trim() || editingAccount.email
              : undefined,
          password: mode === 'credentials' && password.trim() ? password : undefined,
          accentColor: accentColor === 'none' ? undefined : accentColor,
          emoji: emoji.trim() || undefined,
          avatar: avatar || undefined,
          hideLastWatched,
          hideAddonPreview,
          hidePlatformLogos,
        })
      } else {
        if (mode === 'authKey') {
          if (!authKey.trim()) {
            setError('Auth key is required')
            return
          }
          await addAccountByAuthKey(authKey.trim(), name.trim(), accentColor === 'none' ? undefined : accentColor, emoji.trim() || undefined, avatar || undefined)
        } else if (mode === 'credentials') {
          if (!email.trim() || !password.trim()) {
            setError('Email and password are required')
            return
          }
          await addAccountByCredentials(email.trim(), password, name.trim(), accentColor === 'none' ? undefined : accentColor, emoji.trim() || undefined, avatar || undefined, authIntent)
        }
      }
      if (editingAccount) {
        handleClose()
      } else if (beforeIds) {
        const newAccount = useAccountStore.getState().accounts.find(a => !beforeIds.has(a.id))
        if (newAccount) {
          setCreatedAccountId(newAccount.id)
          setConnectedPlatforms(prev => new Set(prev).add('stremio'))
          setWizardStep('connect-more')
        } else {
          handleClose()
        }
      } else {
        handleClose()
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Failed to ${editingAccount ? 'update' : 'add'} account`
      )
    } finally {
      setSubmitting(false)
    }
  }

  const availableAuthMethods = ACCOUNT_AUTH_METHODS

  const renderIdentityStep = () => (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="name" className="text-xs font-medium text-muted-foreground uppercase">Account Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Account"
          className="bg-background/50 border-muted focus:bg-background transition-colors h-11"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleIdentityNext()
            }
          }}
        />
      </div>

      <div className="space-y-3">
        <Label className="text-xs font-medium text-muted-foreground uppercase">Theme Color</Label>
        <div className="flex flex-wrap items-center gap-3">
          <Tooltip content="No accent color" side="top">
            <button
              type="button"
              onClick={() => setAccentColor('none')}
              className={`w-8 h-8 rounded-xl flex items-center justify-center transition-[transform,opacity,box-shadow] hover:scale-110 relative overflow-hidden group ${accentColor === 'none' ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : 'border border-foreground/20'}`}
            >
              <div className="absolute inset-x-0 h-0.5 bg-destructive/50 rotate-45" />
              <div className="text-xs font-bold opacity-40 group-hover:opacity-100 transition-opacity">Off</div>
            </button>
          </Tooltip>

          {ACCOUNT_COLORS.map((hex) => (
            <button
              key={hex}
              type="button"
              onClick={() => setAccentColor(hex)}
              className={`w-8 h-8 rounded-xl transition-[transform,opacity,box-shadow] hover:scale-115 ${accentColor === hex ? 'ring-2 ring-white ring-offset-2 ring-offset-background shadow-lg' : ''}`}
              style={{ backgroundColor: hex }}
            />
          ))}

          <Popover>
            <Tooltip content="Custom color" side="top">
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={`w-8 h-8 rounded-xl transition-[transform,opacity,box-shadow] hover:scale-115 bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] ${(accentColor && accentColor !== 'none' && !ACCOUNT_COLORS.includes(accentColor)) ? 'ring-2 ring-white ring-offset-2 ring-offset-background shadow-lg' : ''}`}
                />
              </PopoverTrigger>
            </Tooltip>
            <PopoverContent className="w-[280px] p-4" align="start">
              <ColorPicker
                value={accentColor && accentColor.startsWith('#') ? accentColor : '#6366f1'}
                onChange={(hex) => setAccentColor(hex)}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-xs font-medium text-muted-foreground uppercase">Account Emoji</Label>
        <div className="flex items-center gap-3">
          <Input
            id="emoji"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="👤"
            className="bg-background/50 border-muted focus:bg-background transition-colors w-14 h-14 text-center text-2xl p-0 rounded-xl shadow-inner"
            maxLength={4}
          />

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="subtle" size="icon" className="h-14 w-14 rounded-xl bg-background/50 border-muted hover:bg-muted/50 transition-[transform,opacity,box-shadow] shadow-sm">
                <Smile className="h-6 w-6 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[320px] p-0 border-border/10 shadow-2xl overflow-hidden rounded-xl" align="start">
              <div className="flex flex-col h-[380px] bg-popover">
                <div className="p-3 border-b border-border/10 bg-muted/20">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search emojis..."
                      className="pl-9 h-9 text-xs bg-muted/30 border border-border/40 focus:bg-muted/40 rounded-lg"
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
                        <h4 className="text-xs font-semibold text-primary/60 mb-3 px-1">{group}</h4>
                        <div className="grid grid-cols-6 gap-2">
                          {filtered.map((e) => (
                            <Tooltip key={e.char} content={e.keywords[0]}>
                              <button
                                type="button"
                                onClick={() => setEmoji(e.char)}
                                className={`h-10 w-10 flex items-center justify-center text-xl rounded-xl transition-[transform,opacity,box-shadow] duration-200 hover:scale-115 hover:bg-primary/20 ${emoji === e.char ? `bg-primary/25 ring-2 ${isLight ? 'ring-primary' : 'ring-primary/50'} shadow-lg scale-110` : 'hover:bg-accent/40'}`}
                              >
                                {e.char}
                              </button>
                            </Tooltip>
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
            className="h-14 px-4 text-xs font-bold uppercase rounded-xl opacity-40 hover:opacity-100 hover:text-destructive hover:bg-destructive/5 transition-[transform,opacity,box-shadow]"
            onClick={() => setEmoji('')}
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase">Avatar URL</Label>
          <p className="text-xs text-muted-foreground mt-1">Direct image link (https://...). Overrides emoji when set. Syncs across devices.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative h-10 w-10 rounded-lg border border-border/40 bg-muted/30 overflow-hidden flex items-center justify-center shrink-0">
            <AccountAvatar account={{ name: name || 'Account', email, emoji, avatar: avatar || undefined, status: 'active' }} size="sm" showStatus={false} />
          </div>
          <input
            type="url"
            data-theme-part="input"
            value={avatar.startsWith('data:') ? '\u2713 Uploaded image' : avatar}
            onChange={(e) => setAvatar(e.target.value)}
            readOnly={avatar.startsWith('data:')}
            placeholder="https://example.com/avatar.png"
            className="flex h-10 w-full rounded-md border border-border/50 bg-background/50 px-3 py-2 text-sm transition-[border,box-shadow] file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
            autoComplete="off"
            spellCheck={false}
          />
          {avatar && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => setAvatar('')}
              aria-label="Clear avatar URL"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
          <ImageUploadButton
            onUploaded={(dataUrl) => setAvatar(dataUrl)}
            options={{ maxDimension: 256, square: true, quality: 0.85 }}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
            label="Upload avatar"
          />
        </div>
      </div>
    </div>
  )

  const renderPlatformStep = () => {
    if (!isEditing && platformStep === 'select') {
      return renderPlatformSelection()
    }
    return renderStremioAuth()
  }

  const renderPlatformSelection = () => (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {PLATFORM_REGISTRY.filter(p => p.available).map(p => {
          const handleClick = () => {
            setError('')
            if (p.id === 'stremio') {
              setPlatformStep('stremio-auth')
            } else if (p.id === 'nuvio') {
              setNuvioDialogOpen(true)
            } else if (p.id === 'realstream') {
              setRealstreamDialogOpen(true)
            } else if (p.id === 'jellyfin') {
              setJellyfinDialogOpen(true)
            } else if (p.id === 'hydra-outbound') {
              setHydraDialogOpen(true)
            }
          }
          return (
            <button
              key={p.id}
              type="button"
              data-theme-part="button"
              onClick={handleClick}
              className={cn(
                'group relative flex min-h-[148px] flex-col items-start gap-4 rounded-[1.35rem] border p-4 text-left transition-[background-color,border-color,box-shadow,transform]',
                'border-border/45 bg-card/65 hover:-translate-y-0.5 hover:border-border/80 hover:bg-muted/30 hover:shadow-md'
              )}
            >
              <span className={cn(
                'flex h-11 w-11 items-center justify-center rounded-2xl border transition-colors',
                'border-border/45 bg-background/60 text-muted-foreground group-hover:text-foreground'
              )}>
                <img src={p.logo} alt={p.name} loading="lazy" className="h-6 w-6 rounded" />
              </span>
              <span className="space-y-1.5 pr-5">
                <span className="block text-[15px] font-semibold leading-tight text-foreground">{p.name}</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">{p.description}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )

  const renderStremioAuth = () => (
    <div className="space-y-5">
      {isExpiredSession && (
        <div data-theme-tone="status" data-theme-part="panel" className="rounded-2xl border border-warning/30 bg-warning/10 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-warning">Session expired</p>
              <p className="text-xs leading-relaxed text-warning/85">
                Stremio rejected the saved token. Use Email & Password for persistent sync, or choose OAuth/Auth Key to replace the token.
              </p>
            </div>
          </div>
        </div>
      )}

      {(!isEditing || isExpiredSession) && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {availableAuthMethods.map(method => {
            const Icon = method.icon
            const isSelected = mode === method.id

            return (
              <button
                key={method.id}
                type="button"
                data-theme-part="tab"
                data-state={isSelected ? 'active' : 'inactive'}
                aria-pressed={isSelected}
                onClick={() => {
                  setMode(method.id)
                  setError('')
                  if (method.id !== 'oauth') {
                    setOauthAuthKey('')
                    setOauthEmail('')
                    setOauthPassword('')
                  }
                }}
                className={cn(
                  'group relative flex min-h-[148px] flex-col items-start gap-4 rounded-[1.35rem] border p-4 text-left transition-[background-color,border-color,box-shadow,transform]',
                  isSelected
                    ? 'border-border/80 bg-muted/30 shadow-md'
                    : 'border-border/45 bg-card/65 hover:-translate-y-0.5 hover:border-border/80 hover:bg-muted/30 hover:shadow-md'
                )}
              >
                <span className={cn(
                  'flex h-11 w-11 items-center justify-center rounded-2xl border transition-colors',
                  isSelected
                    ? 'border-border/45 bg-background/60 text-foreground'
                    : 'border-border/45 bg-background/60 text-muted-foreground group-hover:text-foreground'
                )}>
                  <Icon className="h-5 w-5" />
                </span>
                <span className="space-y-1.5 pr-5">
                  <span className="block text-[15px] font-semibold leading-tight text-foreground">{method.label}</span>
                  <span className="block text-xs leading-relaxed text-muted-foreground">{method.subtitle}</span>
                </span>
                {isSelected && (
                  <span className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-full bg-background text-foreground shadow-sm">
                    <Check className="h-3 w-3" />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {!isEditing && mode === 'credentials' && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted/40 p-1">
            <button type="button" data-theme-part="tab" data-state={authIntent === 'login' ? 'active' : 'inactive'} onClick={() => { setAuthIntent('login'); setError('') }} className={cn('h-9 rounded-lg text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', authIntent === 'login' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}>Sign In</button>
            <button type="button" data-theme-part="tab" data-state={authIntent === 'signup' ? 'active' : 'inactive'} onClick={() => { setAuthIntent('signup'); setError('') }} className={cn('h-9 rounded-lg text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', authIntent === 'signup' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}>Create Account</button>
          </div>
          <p className="text-xs text-muted-foreground px-1">
            {authIntent === 'login'
              ? 'Sign in to an existing Stremio account.'
              : 'Create a brand-new Stremio account with this email and password.'}
          </p>
        </div>
      )}

      {mode === 'oauth' ? (
        oauthAuthKey ? (
          <div data-theme-tone="status" data-theme-part="panel" className="space-y-4 rounded-2xl border border-success/25 bg-success/10 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-success/15 p-2 text-success">
                <ShieldCheck className="h-4 w-4" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-success">OAuth approved</p>
                <p className="text-xs leading-relaxed text-success/85">
                  {isEditing
                    ? 'Save this OAuth token now, or enter your Stremio password to make sync persistent.'
                    : 'Add the account now, or enter your Stremio password to make sync persistent.'}
                </p>
              </div>
            </div>

            <div data-theme-part="panel" className="grid gap-3 rounded-xl border border-border/40 bg-background/50 p-3">
              <div className="space-y-2">
                <Label htmlFor="oauth-email" className="text-xs font-medium text-muted-foreground uppercase">Stremio Email</Label>
                <Input
                  id="oauth-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={oauthEmail}
                  onChange={(e) => {
                    setOauthEmail(e.target.value)
                    setEmail(e.target.value)
                  }}
                  placeholder="your@email.com"
                  className="bg-background/50 border-muted focus:bg-background transition-colors h-11"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="oauth-password" className="text-xs font-medium text-muted-foreground uppercase">Password for persistent sync</Label>
                <Input
                  id="oauth-password"
                  type="password"
                  autoComplete="current-password"
                  value={oauthPassword}
                  onChange={(e) => setOauthPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleSaveOAuthAccount(true)
                    }
                  }}
                  placeholder="Optional, but recommended"
                  className="bg-background/50 border-muted focus:bg-background transition-colors h-11"
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  onClick={() => handleSaveOAuthAccount(true)}
                  disabled={submitting || oauthSaving || oauthEmailLoading || !encryptionKey}
                  className="rounded-xl font-bold text-xs"
                >
                  {oauthSaving ? 'Saving...' : oauthEmailLoading ? 'Checking email...' : isEditing ? 'Save persistent session' : 'Save persistent account'}
                </Button>
                <Button
                  type="button"
                  variant="subtle"
                  onClick={() => handleSaveOAuthAccount(false)}
                  disabled={submitting || oauthSaving || !encryptionKey}
                  className="rounded-xl font-semibold text-xs"
                >
                  {isEditing ? 'Use OAuth token only' : 'Continue with OAuth only'}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <StremioOAuth
            onAuthKey={handleOAuthApproved}
            onError={setError}
            disabled={submitting}
          />
        )
      ) : mode === 'qr' ? (
        <div data-theme-part="panel" className="flex flex-col items-center justify-center p-8 border border-dashed rounded-lg bg-muted/30">
          <div className="mb-4 p-3 rounded-full bg-primary/10">
            <QrCode className="h-6 w-6 text-primary" />
          </div>
          <h3 className="font-semibold text-sm mb-1">Stremio QR Login</h3>
          <p className="text-xs text-muted-foreground text-center mb-6 max-w-[240px]">
            Generate a QR code and scan it with your phone's Stremio app. Approve there, no password needed here.
          </p>
          <Button
            type="button"
            onClick={() => setQrDialogOpen(true)}
            disabled={submitting}
            className="w-full gap-2"
          >
            <QrCode className="h-4 w-4" />
            Generate QR Code
          </Button>
        </div>
      ) : mode === 'authKey' ? (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="authKey" className="text-xs font-medium text-muted-foreground uppercase">Auth Key</Label>
            <Input
              id="authKey"
              type="password"
              value={authKey}
              onChange={(e) => setAuthKey(e.target.value)}
              placeholder={isExpiredSession ? 'Paste a fresh Stremio auth key' : isEditing ? '••••• (encrypted)' : 'Enter your Stremio auth key'}
              required={!isEditing || isExpiredSession}
              className="bg-background/50 border-muted focus:bg-background transition-colors h-11"
            />
            {isExpiredSession && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                OAuth tokens can expire after Stremio Web logout. Email & Password is the only auto-refresh path.
              </p>
            )}
          </div>
          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="link"
              onClick={() => setShowHelp(!showHelp)}
              className="h-auto gap-1 p-0 text-xs font-medium"
            >
              <HelpCircle className="h-3.5 w-3.5" />
              {showHelp ? 'Hide instructions' : 'Where to find?'}
            </Button>
            <Link
              to="/kronorium/getting-started/first-account#method-2-authkey-advanced"
              onClick={handleClose}
              className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1"
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
                <div data-theme-part="panel" className="p-3 bg-muted/50 rounded-xl border border-border/10 space-y-3 mt-1">
                  <div className="space-y-2">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      1. Log into <a href="https://web.stremio.com/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline italic">web.stremio.com</a>
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      2. Run in Console (<kbd className="px-1 py-0.5 rounded bg-muted border border-border text-xs">F12</kbd>):
                    </p>
                    <pre
                      data-theme-part="field"
                      className="text-xs bg-muted p-2 rounded border border-border font-mono text-muted-foreground select-all cursor-pointer hover:bg-muted/80 transition-colors"
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
            <Label htmlFor="email" className="text-xs font-medium text-muted-foreground uppercase">Email</Label>
            <Input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required={!isEditing}
              autoFocus
              className="bg-background/50 border-muted focus:bg-background transition-colors h-11"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className="text-xs font-medium text-muted-foreground uppercase">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={isEditing ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isExpiredSession ? 'Enter password to restore sync' : isEditing ? 'Leave blank to keep unchanged' : 'Enter your password'}
              required={!isEditing}
              className="bg-background/50 border-muted focus:bg-background transition-colors h-11"
            />
            {isExpiredSession && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Saving Email & Password stores the password encrypted locally so AIOManager can refresh future Stremio auth keys automatically.
              </p>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                data-theme-part="button"
                onClick={() => window.open(buildResetPasswordUrl(email), '_blank', 'noopener,noreferrer')}
                className="text-xs text-primary hover:underline"
              >
                Forgot password?
              </button>
            </div>
          </div>
        </div>
      )}

      {(!isEditing || isExpiredSession) && !(mode === 'oauth' && oauthAuthKey) && (
        <StremioSocialAuth
          onAuthKey={(key, user) => {
            handleOAuthApproved(key, user)
            setMode('oauth')
          }}
          onError={setError}
          disabled={submitting}
        />
      )}

      {isEditing && (
        <div className="border-t border-border/10 pt-4 space-y-1">
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium">Hide last watched</p>
              <p className="text-xs text-muted-foreground">Don't show what this account is currently watching on the card.</p>
            </div>
            <Switch
              checked={hideLastWatched}
              onCheckedChange={setHideLastWatched}
            />
          </div>
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium">Hide addon preview</p>
              <p className="text-xs text-muted-foreground">Don't show addon logos on the card.</p>
            </div>
            <Switch
              checked={hideAddonPreview}
              onCheckedChange={setHideAddonPreview}
            />
          </div>
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium">Hide platform logos</p>
              <p className="text-xs text-muted-foreground">Don't show connection logos on the card.</p>
            </div>
            <Switch
              checked={hidePlatformLogos}
              onCheckedChange={setHidePlatformLogos}
            />
          </div>
        </div>
      )}
    </div>
  )

  const renderConnectMoreStep = () => (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-sm font-semibold text-foreground">Connect more platforms</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          This account can connect to multiple platforms. Add more now or skip to finish.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {PLATFORM_REGISTRY.filter(p => p.available && (connectedPlatforms.has(p.id) || p.id !== 'stremio')).map(p => {
          const isConnected = p.id !== 'jellyfin' && connectedPlatforms.has(p.id)
          const handleConnect = () => {
            setError('')
            if (p.id === 'nuvio') {
              setNuvioDialogOpen(true)
            } else if (p.id === 'realstream') {
              setRealstreamDialogOpen(true)
            } else if (p.id === 'jellyfin') {
              setJellyfinDialogOpen(true)
            } else if (p.id === 'hydra-outbound') {
              setHydraDialogOpen(true)
            }
          }
          return (
            <div
              key={p.id}
              data-theme-part="card"
              className={cn(
                'group relative flex min-h-[148px] flex-col items-start gap-4 rounded-[1.35rem] border p-4 text-left transition-[background-color,border-color,box-shadow,transform]',
                isConnected
                  ? 'border-success/30 bg-success/5'
                  : 'border-border/45 bg-card/65 hover:-translate-y-0.5 hover:border-border/80 hover:bg-muted/30 hover:shadow-md'
              )}
            >
              <span className={cn(
                'flex h-11 w-11 items-center justify-center rounded-2xl border transition-colors',
                'border-border/45 bg-background/60 text-muted-foreground group-hover:text-foreground'
              )}>
                <img src={p.logo} alt={p.name} loading="lazy" className="h-6 w-6 rounded" />
              </span>
              <span className="space-y-1.5 pr-5 flex-1">
                <span className="block text-[15px] font-semibold leading-tight text-foreground">{p.name}</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">{p.description}</span>
              </span>
              {isConnected ? (
                <span data-theme-part="badge" className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-semibold text-success">
                  <Check className="h-3 w-3" />
                  Connected
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={handleConnect}
                  className="rounded-xl font-bold text-xs"
                >
                  Connect
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )

  const emojiPickerContent = (
    <div className="flex flex-col h-[380px] bg-popover">
      <div className="p-3 border-b border-border/10 bg-muted/20">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search emojis..."
            className="pl-9 h-9 text-xs bg-muted/30 border border-border/40 focus:bg-muted/40 rounded-lg"
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
              <h4 className="text-xs font-semibold text-primary/60 mb-3 px-1">{group}</h4>
              <div className="grid grid-cols-6 gap-2">
                {filtered.map((e) => (
                  <Tooltip key={e.char} content={e.keywords[0]}>
                    <button
                      type="button"
                      onClick={() => { setEmoji(e.char); setAvatar('') }}
                      className={`h-10 w-10 flex items-center justify-center text-xl rounded-xl transition-[transform,opacity,box-shadow] duration-200 hover:scale-115 hover:bg-primary/20 ${emoji === e.char ? `bg-primary/25 ring-2 ${isLight ? 'ring-primary' : 'ring-primary/50'} shadow-lg scale-110` : 'hover:bg-accent/40'}`}
                    >
                      {e.char}
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )

  const connectionsCount = activeConnectionsLabel(liveAccount?.connections ?? editTarget?.connections ?? [])
  const hasAccentColor = !!accentColor && accentColor !== 'none'

  const renderEditingView = () => {
    const previewAccount = liveAccount ?? editTarget
    return (
    <form
      onSubmit={(e) => {
        // Submits from portaled setup dialogs still bubble here through the React tree.
        if (e.target !== e.currentTarget) return
        handleSubmit(e)
      }}
      className="mt-4 min-w-0"
    >
      <div className="flex items-center gap-2 pb-4">
        {editPage === 'connections' ? (
          <>
            <span className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={editPageBack}
                aria-label="Back to account"
                className="h-11 w-11 rounded-full p-0"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={editPageForward}
                disabled={!editCanForward}
                aria-label="Forward"
                className="h-11 w-11 rounded-full p-0 disabled:opacity-35"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </span>
            <DialogTitle className="min-w-0 flex-1 truncate text-left text-lg font-bold leading-tight tracking-tight">Connections</DialogTitle>
            <span aria-hidden="true" className="h-11 w-11 shrink-0" />
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={handleClose}
              className="h-11 shrink-0 rounded-full px-3 text-sm font-semibold text-muted-foreground hover:text-foreground"
            >
              Cancel
            </Button>
            {editCanForward && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={editPageForward}
                aria-label="Forward to connections"
                className="h-11 w-11 shrink-0 rounded-full p-0 disabled:opacity-35"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            )}
            <DialogTitle className="min-w-0 flex-1 truncate text-center text-base font-bold">Edit Account</DialogTitle>
            <Button
              type="submit"
              disabled={submitting || !encryptionKey || avatarProcessing}
              className="h-11 shrink-0 rounded-full px-4 text-sm font-bold transition-[transform,opacity,box-shadow]"
            >
              {submitting ? 'Saving...' : !encryptionKey ? 'Vault locked' : avatarProcessing ? 'Processing...' : 'Done'}
            </Button>
          </>
        )}
      </div>

      {editPage === 'profile' ? (
        <div className="space-y-5">
          {isExpiredSession && (
            <div data-theme-tone="status" data-theme-part="panel" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/25 bg-warning/10 px-4 py-3 text-warning">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <p className="min-w-0 flex-1 text-sm font-medium">{expiredSessionPlatformName} session expired</p>
              {expiredSessionConnection && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0 border-warning/35 bg-background/60 text-warning hover:bg-warning/10"
                  onClick={() => {
                    preloadConnectionManager()
                    setEditPage('connections')
                    setSignInAgainTarget({ id: expiredSessionConnection.id, nonce: Date.now() })
                  }}
                >
                  Sign in again
                </Button>
              )}
            </div>
          )}

          <div className="flex flex-col items-center">
            <div className="relative">
              <AccountAvatar
                account={{ name: name || 'Account', email, emoji, avatar: avatar || undefined, status: 'active' }}
                size="lg"
                showStatus={false}
                className="h-24 w-24 rounded-full [&>span]:text-5xl [&>span>span]:text-4xl"
              />
              {hasAccentColor && (
                <span
                  className="pointer-events-none absolute inset-0 rounded-full"
                  style={{ boxShadow: `inset 0 0 0 2px color-mix(in srgb, ${accentColor} 65%, transparent)` }}
                  aria-hidden="true"
                />
              )}
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger asChild>
                  <span aria-hidden="true" tabIndex={-1} className="pointer-events-none absolute left-1/2 top-1/2 h-px w-px" />
                </PopoverTrigger>
                <PopoverContent className="w-[320px] p-0 border-border/10 shadow-2xl overflow-hidden rounded-xl" align="center">
                  {emojiPickerContent}
                </PopoverContent>
              </Popover>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="subtle" className="mt-2 h-11 rounded-full px-5 text-xs font-semibold">
                  Edit photo
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="w-60">
                <DropdownMenuItem onClick={() => avatarFileInputRef.current?.click()}>
                  Upload photo
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setEmojiOpen(true)}>
                  Choose emoji
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => {
                  setShowAvatarUrl(true)
                  window.setTimeout(() => {
                    const input = document.getElementById('edit-avatar-url') as HTMLInputElement | null
                    input?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                    input?.focus()
                  }, 120)
                }}>
                  Paste image link
                </DropdownMenuItem>
                <DropdownMenuItem destructive onClick={() => { setAvatar(''); setEmoji('') }}>
                  Remove photo
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <input
              ref={avatarFileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleAvatarFile(file)
                e.target.value = ''
              }}
            />
          </div>

          <div className="mx-auto w-full max-w-[280px]">
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Account"
              className="h-11 rounded-xl border-muted bg-background/50 text-center text-base font-semibold focus:bg-background"
              maxLength={32}
            />
          </div>

          {showAvatarUrl && (
            <div className="space-y-2">
              <div>
                <Label htmlFor="edit-avatar-url" className="text-xs font-medium text-muted-foreground">Image link</Label>
                <p className="text-xs text-muted-foreground mt-1">Direct image link (https://...). Overrides emoji when set. Syncs across devices.</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative h-10 w-10 rounded-lg border border-border/40 bg-muted/30 overflow-hidden flex items-center justify-center shrink-0">
                  <AccountAvatar account={{ name: name || 'Account', email, emoji, avatar: avatar || undefined, status: 'active' }} size="sm" showStatus={false} />
                </div>
                <input
                  id="edit-avatar-url"
                  type="url"
                  data-theme-part="input"
                  value={avatar.startsWith('data:') ? '\u2713 Uploaded image' : avatar}
                  onChange={(e) => setAvatar(e.target.value)}
                  readOnly={avatar.startsWith('data:')}
                  placeholder="https://example.com/avatar.png"
                  className="flex h-10 w-full rounded-md border border-border/50 bg-background/50 px-3 py-2 text-sm transition-[border,box-shadow] file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
                  autoComplete="off"
                  spellCheck={false}
                />
                {avatar && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setAvatar('')}
                    aria-label="Clear avatar URL"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          )}

          <div data-theme-part="panel" className="overflow-hidden rounded-2xl border border-border/40 bg-muted/10">
            <div className="border-b border-border/30">
              <button
                type="button"
                onClick={() => setColorOpen(current => !current)}
                aria-expanded={colorOpen}
                className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-1.5 text-left transition-colors hover:bg-muted/30"
              >
                <span className="text-sm font-semibold">Color</span>
                <span className="flex items-center gap-2.5">
                  <span
                    className="h-4 w-4 shrink-0 rounded-full border border-foreground/15 shadow-inner"
                    style={{ background: hasAccentColor ? accentColor : 'transparent' }}
                  />
                  <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', colorOpen && 'rotate-90')} />
                </span>
              </button>
              {colorOpen && (
                <div className="space-y-4 px-4 pb-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Tooltip content="No accent color" side="top">
                      <button
                        key="none"
                        type="button"
                        onClick={() => setAccentColor('none')}
                        className={`w-8 h-8 rounded-xl flex items-center justify-center transition-[transform,opacity,box-shadow] hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background relative overflow-hidden group ${accentColor === 'none' ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : 'border border-foreground/20'}`}
                      >
                        <div className="absolute inset-x-0 h-0.5 bg-destructive/50 rotate-45" />
                        <div className="text-xs font-bold opacity-40 group-hover:opacity-100 transition-opacity">Off</div>
                      </button>
                    </Tooltip>

                    {ACCOUNT_COLORS.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        onClick={() => setAccentColor(hex)}
                        className={`w-8 h-8 rounded-xl transition-[transform,opacity,box-shadow] hover:scale-115 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${accentColor === hex ? 'ring-2 ring-white ring-offset-2 ring-offset-background shadow-lg' : ''}`}
                        style={{ backgroundColor: hex }}
                      />
                    ))}

                    <Popover>
                      <Tooltip content="Custom color" side="top">
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className={`w-8 h-8 rounded-xl transition-[transform,opacity,box-shadow] hover:scale-115 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] ${(accentColor && accentColor !== 'none' && !ACCOUNT_COLORS.includes(accentColor)) ? 'ring-2 ring-white ring-offset-2 ring-offset-background shadow-lg' : ''}`}
                          />
                        </PopoverTrigger>
                      </Tooltip>
                      <PopoverContent className="w-[280px] p-4" align="start">
                        <ColorPicker
                          value={accentColor && accentColor.startsWith('#') ? accentColor : '#6366f1'}
                          onChange={(hex) => setAccentColor(hex)}
                        />
                      </PopoverContent>
                    </Popover>
                  </div>

                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-xl shadow-inner border border-foreground/10 shrink-0 transition-colors duration-500"
                      style={{ background: hasAccentColor ? accentColor : 'transparent' }}
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
              )}
            </div>

            <div className="border-b border-border/30">
              <button
                type="button"
                onClick={() => setCardOpen(current => !current)}
                aria-expanded={cardOpen}
                className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-1.5 text-left transition-colors hover:bg-muted/30"
              >
                <span className="shrink-0 text-sm font-semibold">On the card</span>
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="truncate text-xs text-muted-foreground">
                    {cardVisibilitySummary({ hideLastWatched, hideAddonPreview, hidePlatformLogos })}
                  </span>
                  <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', cardOpen && 'rotate-90')} />
                </span>
              </button>
              {cardOpen && (
                <div className="px-4 pb-2">
                  <div className="flex items-center justify-between py-2">
                    <div>
                      <p className="text-sm font-medium">Hide last watched</p>
                      <p className="text-xs text-muted-foreground">Don't show what this account is currently watching on the card.</p>
                    </div>
                    <Switch
                      checked={hideLastWatched}
                      onCheckedChange={setHideLastWatched}
                    />
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <div>
                      <p className="text-sm font-medium">Hide addon preview</p>
                      <p className="text-xs text-muted-foreground">Don't show addon logos on the card.</p>
                    </div>
                    <Switch
                      checked={hideAddonPreview}
                      onCheckedChange={setHideAddonPreview}
                    />
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <div>
                      <p className="text-sm font-medium">Hide platform logos</p>
                      <p className="text-xs text-muted-foreground">Don't show connection logos on the card.</p>
                    </div>
                    <Switch
                      checked={hidePlatformLogos}
                      onCheckedChange={setHidePlatformLogos}
                    />
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => { preloadConnectionManager(); setEditPage('connections') }}
              onPointerEnter={preloadConnectionManager}
              onFocus={preloadConnectionManager}
              className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-1.5 text-left transition-colors hover:bg-muted/30"
            >
              <span className="text-sm font-semibold">Connections</span>
              <span className="flex items-center gap-2.5">
                <span className="text-xs text-muted-foreground">{connectionsCount}</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </span>
            </button>
          </div>

          {editTarget && encryptionKey && (
            <ConnectionPicturesSection accountId={editTarget.id} />
          )}

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">How it looks</p>
            {(() => {
              const displayName = name || (email ? email.split('@')[0] : 'My Account')
              const maskedDisplayName = maskedAccountLabel({ name: displayName, email })
              const addonCount = loading ? '-' : previewAccount?.addons.length ?? 0
              const enabledAddons = (previewAccount?.addons ?? []).filter(a => a.flags?.enabled !== false)
              let addonPreviewCount = 4
              try { addonPreviewCount = parseInt(localStorage.getItem('aioman:addon-preview-count') || '4') } catch { /* keep 4 */ }
              const previewAddons = addonPreviewCount === 0 ? enabledAddons : enabledAddons.slice(0, addonPreviewCount)
              const remainingCount = addonPreviewCount === 0 ? 0 : Math.max(0, enabledAddons.length - addonPreviewCount)
              const platformSummary = previewAccount ? aggregateAccountPlatforms([previewAccount]) : null
              const hasPlatformSources = previewAccount ? accountPlatformSources(previewAccount).length > 0 : false
              const previewPlayback = accountMediaPlayback(previewMedia.playback, previewLastWatched)
              return (
                <div data-theme-part="panel" className="pointer-events-none relative flex flex-col rounded-2xl border border-border/40 bg-card shadow-sm">
                  <div className="flex items-start justify-between px-5 pb-2 pt-5">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div className="relative shrink-0">
                        <AccountAvatar account={{ name: displayName, email, emoji, avatar: avatar || undefined, status: 'active' }} size="lg" showStatus={false} accentColor={hasAccentColor ? accentColor : undefined} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-base font-semibold leading-tight tracking-tight">{maskedDisplayName}</p>
                        {email && (
                          <p className="sr-only mt-0.5 truncate text-xs text-muted-foreground">{maskedAccountLabel({ email })}</p>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs leading-tight text-muted-foreground">
                          <span className="inline-flex items-center gap-2">
                            {!hidePlatformLogos && hasPlatformSources && platformSummary && platformSummary.platforms.length > 0 && (
                              <span className="inline-flex items-center gap-1 border-r border-border/50 pr-2">
                                {platformSummary.platforms.map(platformId => {
                                  const entry = getPlatformEntry(platformId)
                                  return entry ? (
                                    <img key={platformId} src={entry.logo} alt="" loading="lazy" className="h-3.5 w-3.5 shrink-0 rounded-full object-contain" />
                                  ) : (
                                    <span key={platformId} className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-bold text-muted-foreground">
                                      {platformId[0]?.toUpperCase() || '?'}
                                    </span>
                                  )
                                })}
                                <span>{platformSummary.platforms.length} platform{platformSummary.platforms.length === 1 ? '' : 's'}</span>
                              </span>
                            )}
                            {!hasPlatformSources && (
                              <span className="border-r border-border/50 pr-2 text-[11px]">Local</span>
                            )}
                            <span className="whitespace-nowrap">{addonCount} addon{addonCount === 1 ? '' : 's'}</span>
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="min-w-0 flex-grow px-5 pb-2 pt-2">
                    {!hideAddonPreview && enabledAddons.length > 0 && (
                      <div className="flex min-h-6 flex-wrap items-center gap-1.5">
                        {previewAddons.map((addon, i) => (
                          <AddonPreviewTile key={`${addon.transportUrl}-${i}`} src={addon.manifest.logo} name={addon.manifest.name} />
                        ))}
                        {remainingCount > 0 && (
                          <span className="ml-0.5 text-[11px] text-muted-foreground">+{remainingCount}</span>
                        )}
                      </div>
                    )}
                    {previewAccount && previewAccount.addons.length === 0 && (
                      <p className="py-1 text-xs text-muted-foreground">No addons yet</p>
                    )}
                  </div>
                  <div className="mt-auto flex min-h-5 flex-wrap items-center gap-1.5 px-5 pb-4 text-xs">
                    {!hideLastWatched && (previewPlayback ? (
                      <AccountMediaPlayback playback={previewPlayback} />
                    ) : previewLastWatched && (
                      <>
                        <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground/65" aria-hidden="true" />
                        <span className="truncate font-medium text-foreground/80">{previewLastWatched.name}</span>
                        <time className="ml-0.5 shrink-0 text-[11px] text-muted-foreground">{getTimeAgo(new Date(previewLastWatched.timestamp))}</time>
                      </>
                    ))}
                  </div>
                </div>
              )
            })()}
          </div>

          {error && (
            isStremioPasswordResetError(error) ? (
              <StremioPasswordResetPanel email={email} onTryAgain={() => void handleSubmit()} />
            ) : (
              <div data-theme-tone="status" data-theme-part="panel" className="bg-destructive/10 border border-destructive/50 rounded-xl px-4 py-3 animate-in shake duration-500">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-bold text-destructive">{error}</p>
                  </div>
                </div>
              </div>
            )
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {editTarget && (
            <Suspense fallback={null}>
            <ConnectionManager
              variant="sheet"
              accountId={editTarget.id}
              connections={liveAccount?.connections ?? editTarget.connections}
              focusEditConnection={signInAgainTarget}
            />
            </Suspense>
          )}
        </div>
      )}
    </form>
    )
  }

  if (isEditing) {
    return (
      <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleClose() }}>
        <DialogContent ref={editSheetRef} tabIndex={-1} className="outline-none sm:max-w-2xl" hideClose>
          <DialogBack active={editPage === 'connections' && editCanBack} onBack={editPageBack} />
          {/* Registered before the Connections content so its panel history stays deeper in the shared Alt stack. */}
          <DialogAltHistory
            active={isOpen && isEditing && (editCanBack || editCanForward)}
            canBack={editCanBack}
            canForward={editCanForward}
            onBack={editPageBack}
            onForward={editPageForward}
          />
          {renderEditingView()}
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <>
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {wizardStep === 'identity'
              ? 'Create Account'
              : wizardStep === 'connect-more'
                ? 'Connect More Platforms'
                : platformStep === 'select'
                  ? 'Connect a Platform'
                  : 'Connect Stremio'}
          </DialogTitle>
          <DialogDescription>
            {wizardStep === 'identity'
              ? 'Set up your account identity.'
              : wizardStep === 'connect-more'
                ? 'Link additional platforms to this account.'
                : platformStep === 'select'
                  ? 'Link a streaming platform, or skip for a local-only hub.'
                  : 'Choose how to connect your Stremio account.'}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4">
          {wizardStep === 'identity'
            ? renderIdentityStep()
            : wizardStep === 'connect-more'
              ? renderConnectMoreStep()
              : renderPlatformStep()}
        </div>

        {error && (
          isStremioPasswordResetError(error) ? (
            <StremioPasswordResetPanel email={email} onTryAgain={() => void handleSubmit()} />
          ) : (
            <div role="alert" data-theme-tone="status" data-theme-part="panel" className="bg-destructive/10 border border-destructive/50 rounded-xl px-4 py-3 animate-in shake duration-500">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-bold text-destructive">{error}</p>
                </div>
              </div>
            </div>
          )
        )}

        <DialogFooter className="mt-6 pt-2">
          {wizardStep === 'identity' ? (
            <>
              <Button type="button" variant="subtle" onClick={handleClose} className="rounded-xl font-semibold text-xs">
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleIdentityNext}
                disabled={!name.trim()}
                className="rounded-xl font-bold text-xs px-8"
              >
                Next
              </Button>
            </>
          ) : wizardStep === 'connect-more' ? (
            <>
              <Button type="button" variant="subtle" onClick={handleClose} className="rounded-xl font-semibold text-xs">
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleClose}
                className="rounded-xl font-bold text-xs px-8"
              >
                Finish
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="subtle"
                onClick={() => {
                  if (platformStep === 'stremio-auth') {
                    setPlatformStep('select')
                    setError('')
                  } else {
                    setWizardStep('identity')
                  }
                }}
                className="rounded-xl font-semibold text-xs"
              >
                Back
              </Button>
              {!isEditing && (
                <Button
                  type="button"
                  variant="subtle"
                  onClick={handleSkipLocal}
                  disabled={submitting}
                  className="rounded-xl font-semibold text-xs"
                >
                  Skip for Now
                </Button>
              )}
              {platformStep === 'stremio-auth' && mode !== 'oauth' && mode !== 'qr' && (
                <Button
                  type="button"
                  onClick={(e) => handleSubmit(e as unknown as React.FormEvent)}
                  disabled={submitting || !encryptionKey}
                  className="rounded-xl font-bold text-xs px-8"
                >
                  {submitting ? 'Adding...' : !encryptionKey ? 'Vault Locked' : 'Connect & Create'}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <QRLinkDialog
      open={qrDialogOpen}
      onOpenChange={setQrDialogOpen}
      title="Log in with QR Code"
      description="Open your phone's Stremio app, scan the code, and approve the login."
      start={createStremioLink}
      poll={pollStremioLink}
      onClaimed={(session: QRSession) => {
        const authKey = (session.platformData as { authKey?: string } | undefined)?.authKey
        if (!authKey) {
          if (import.meta.env.DEV) console.error('[AccountForm] QR approval returned no auth key')
          return
        }
        setQrDialogOpen(false)
        handleOAuthApproved(authKey)
        setMode('oauth')
      }}
    />

    <NuvioSetupDialog
      open={nuvioDialogOpen}
      onOpenChange={setNuvioDialogOpen}
      onComplete={handleNuvioAccountComplete}
    />

    {jellyfinDialogOpen && <JellyfinSetupDialog
      open={jellyfinDialogOpen}
      onOpenChange={setJellyfinDialogOpen}
      onComplete={handleJellyfinAccountComplete}
    />}

    <RealStreamSetupDialog
      open={realstreamDialogOpen}
      onOpenChange={setRealstreamDialogOpen}
      onComplete={handleRealStreamAccountComplete}
    />

    <ProviderSetupDialog
      open={hydraDialogOpen}
      onOpenChange={setHydraDialogOpen}
      onComplete={handleHydraAccountComplete}
    />
  </>
  )
}
