import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAccounts } from '@/hooks/useAccounts'
import { useUIStore } from '@/store/uiStore'
import { useFailoverStore } from '@/store/failoverStore'
import { useLibraryCache } from '@/store/libraryCache'
import { StremioAccount } from '@/types/account'
import { AlertCircle, MoreVertical, Pencil, RefreshCw, Trash, GripVertical, ShieldCheck, AlertTriangle, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { maskEmail, getTimeAgo } from '@/lib/utils'
import { useMemo, useRef, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

interface AccountCardProps {
  account: StremioAccount
  isSelected?: boolean
  onToggleSelect?: (accountId: string) => void
  onDelete?: () => void
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>
  isSelectionMode?: boolean
  disableTransition?: boolean
  isPrivacyMode?: boolean
}

export function AccountCard({
  account,
  isSelected = false,
  onToggleSelect,
  onDelete,
  isSelectionMode = false,
  disableTransition = false,
  isPrivacyMode = false,
  ...restProps
}: AccountCardProps) {
  const navigate = useNavigate()
  const preventNavRef = useRef(false)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const { syncAccount, repairAccount, loading } = useAccounts()
  const { openAddAccountDialog, isAddAccountDialogOpen } = useUIStore(
    useShallow((state) => ({
      openAddAccountDialog: state.openAddAccountDialog,
      isAddAccountDialogOpen: state.isAddAccountDialogOpen
    }))
  )
  const allRules = useFailoverStore((state) => state.rules)
  const failoverRules = useMemo(() => allRules.filter(r => r.accountId === account.id), [allRules, account.id])
  const activeRules = useMemo(() => failoverRules.filter(r => r.isActive), [failoverRules])
  const failedOverRules = useMemo(() => activeRules.filter(r => r.activeUrl !== r.priorityChain?.[0]), [activeRules])

  // Watch dialog state to prevent accidental navigation when it closes
  useEffect(() => {
    if (!isAddAccountDialogOpen) {
      preventNavRef.current = true
      const timer = setTimeout(() => {
        preventNavRef.current = false
      }, 400)
      return () => clearTimeout(timer)
    }
  }, [isAddAccountDialogOpen])

  const items = useLibraryCache((state) => state.items)
  const libraryLoading = useLibraryCache((state) => state.loading)

  const prevLastWatchedRef = useRef<any>(null)

  const lastWatched = useMemo(() => {
    if (items.length === 0 && libraryLoading) return prevLastWatchedRef.current

    const accountItems = items.filter(i => i.accountId === account.id)
    if (accountItems.length === 0) {
      if (libraryLoading) return prevLastWatchedRef.current
      prevLastWatchedRef.current = null
      return null
    }

    const latest = accountItems.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0]
    prevLastWatchedRef.current = latest
    return latest
  }, [items, libraryLoading, account.id])

  const handleSync = async () => {
    try {
      await syncAccount(account.id)
    } catch (error) {
      // Error is already stored in the store
      console.error('Sync failed:', error)
    }
  }

  const handleEdit = () => {
    openAddAccountDialog(account)
  }

  const statusColor = account.status === 'active' ? 'bg-green-500' : 'bg-red-500'
  const timeStr = getTimeAgo(new Date(account.lastSync))

  const isNameCustomized = account.name !== account.email && account.name !== 'Stremio Account'
  const displayName =
    isPrivacyMode && !isNameCustomized
      ? account.name.includes('@')
        ? maskEmail(account.name)
        : '********'
      : account.name

  const hasAccentColor = account.accentColor && account.accentColor !== 'none'
  const cardBorderColor = hasAccentColor ? account.accentColor : 'transparent'

  return (
    <Card
      className={`group flex flex-col cursor-pointer relative ${!disableTransition ? 'transition-all duration-200' : ''} ${isSelectionMode ? 'hover:border-primary/50' : 'hover:bg-accent/30'} ${isSelected ? 'ring-2 ring-primary border-primary bg-primary/5' : ''
        } ${isMenuOpen ? 'z-40' : ''}`}
      style={{
        borderLeft: hasAccentColor ? `3px solid ${cardBorderColor}` : undefined
      }}
      onClick={(e) => {
        if (preventNavRef.current) return
        if (e.detail === 0) return // Ignore programmatic clicks (focus return from dialog)
        if (isSelectionMode && onToggleSelect) {
          onToggleSelect(account.id)
        } else if (!isSelectionMode) {
          navigate(`/account/${account.id}`)
        }
      }}
    >
      {isSelected && (
        <div
          className="absolute -top-2 -right-2 z-30 w-6 h-6 rounded-full border-2 border-background shadow-lg flex items-center justify-center transition-all animate-in zoom-in-50 duration-200"
          style={{ background: 'hsl(var(--primary))' }}
        >
          <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}
      <CardHeader className="relative pb-3">
        {/* Drag Handle Overlay - Increased Touch Target */}
        {restProps.dragHandleProps && (
          <div
            {...restProps.dragHandleProps}
            className="
              absolute left-0 top-0 bottom-0 px-4 
              flex items-center justify-center 
              cursor-grab active:cursor-grabbing 
              text-muted-foreground hover:text-foreground 
              hover:bg-accent/50 transition-colors 
              z-10
            "
            style={{ touchAction: 'none' }}
            title="Drag to reorder"
          >
            <GripVertical className="h-5 w-5" />
          </div>
        )}

        <div className={`flex items-center justify-between ${restProps.dragHandleProps ? 'pl-8' : ''}`}>
          <div className="flex items-center gap-4 flex-1 min-w-0">

            <div className="flex-1 min-w-0">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold truncate tracking-tight">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor}`} title={account.status === 'active' ? 'Active' : 'Error'} />
                {account.emoji && <span className="text-xl mr-0.5">{account.emoji}</span>}
                <span className="truncate flex-1">{displayName}</span>
              </CardTitle>

              {account.email && account.email !== account.name && (
                <p className="text-sm text-muted-foreground mt-1 truncate">
                  {isPrivacyMode ? maskEmail(account.email) : account.email}
                </p>
              )}
            </div>

            {!isSelectionMode && (
              <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity -ml-2" />
            )}

            <DropdownMenu onOpenChange={(open) => {
              setIsMenuOpen(open)
              if (!open) {
                preventNavRef.current = true
                setTimeout(() => { preventNavRef.current = false }, 400)
              }
            }}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 p-0" onClick={(e) => e.stopPropagation()}>
                  <span className="sr-only">Open menu</span>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-50">
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleEdit(); }}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleSync(); }} disabled={loading}>
                  <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  Sync
                </DropdownMenuItem>
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); repairAccount(account.id); }} disabled={loading} className="cursor-pointer whitespace-nowrap">
                  <RefreshCw className={`mr-2 h-4 w-4 text-amber-500 shrink-0 ${loading ? 'animate-spin' : ''}`} />
                  Repair Account (Deep Refresh)
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={(e) => { e.stopPropagation(); onDelete?.(); }}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-grow">
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-muted-foreground">Addons:</span>
            <span className="font-medium">{account.addons.length}</span>
          </div>
          {activeRules.length > 0 && (
            <div className="flex items-center gap-1.5 text-sm">
              {failedOverRules.length > 0 ? (
                <>
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                  <span className="text-amber-600 dark:text-amber-400 font-medium truncate">
                    {failedOverRules.length} rule{failedOverRules.length !== 1 ? 's' : ''} failed over
                  </span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-3.5 h-3.5 text-green-500" />
                  <span className="text-green-600 dark:text-green-400 font-medium truncate">
                    {activeRules.length} rule{activeRules.length !== 1 ? 's' : ''} healthy
                  </span>
                </>
              )}
            </div>
          )}
          {lastWatched && (
            <div className="flex items-center gap-1.5 text-sm mt-1">
              <span className="text-muted-foreground">Last watched:</span>
              <span className="font-medium truncate max-w-[160px]">{lastWatched.name}</span>
              <span className="text-muted-foreground text-xs shrink-0">&middot; {getTimeAgo(new Date(lastWatched.timestamp))}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 text-sm">
            <span className={`text-muted-foreground ${(Date.now() - new Date(account.lastSync).getTime()) > 24 * 60 * 60 * 1000 ? 'flex items-center gap-1' : ''}`}>
              {(Date.now() - new Date(account.lastSync).getTime()) > 24 * 60 * 60 * 1000 && (
                <span title="Sync recommended (Last sync > 24h ago)">
                  <AlertTriangle className="w-3 h-3 text-amber-500" />
                </span>
              )}
              Synced {timeStr}
            </span>
          </div>
          {account.status === 'error' && (
            <div className="bg-destructive/10 border border-destructive/50 rounded-md p-3 mt-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-destructive">Authentication Failed</p>
                  <p className="text-xs text-destructive/80 mt-0.5">
                    Your credentials are invalid or expired
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  handleEdit()
                }}
                className="w-full mt-2 border-destructive/30 text-destructive hover:bg-destructive/20"
              >
                <Pencil className="h-3 w-3 mr-2" />
                Update Credentials
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
