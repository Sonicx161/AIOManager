import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAccounts } from '@/hooks/useAccounts'
import { useUIStore } from '@/store/uiStore'
import { StremioAccount } from '@/types/account'
import { AlertCircle, MoreVertical, Pencil, RefreshCw, Trash, GripVertical } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { maskEmail } from '@/lib/utils'

interface AccountCardProps {
  account: StremioAccount
  isSelected?: boolean
  onToggleSelect?: (accountId: string) => void
  onDelete?: () => void
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>
  isSelectionMode?: boolean
}

export function AccountCard({
  account,
  isSelected = false,
  onToggleSelect,
  onDelete,
  isSelectionMode = false,
  ...restProps
}: AccountCardProps) {
  const navigate = useNavigate()
  const { syncAccount, repairAccount, loading } = useAccounts()
  const openAddAccountDialog = useUIStore((state) => state.openAddAccountDialog)

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
  const lastSyncText = new Date(account.lastSync).toLocaleString()
  const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)

  const isNameCustomized = account.name !== account.email && account.name !== 'Stremio Account'
  const displayName =
    isPrivacyModeEnabled && !isNameCustomized
      ? account.name.includes('@')
        ? maskEmail(account.name)
        : '********'
      : account.name

  return (
    <Card
      className={`flex flex-col transition-all duration-200 ${isSelectionMode ? 'cursor-pointer hover:border-primary/50' : ''} ${isSelected ? 'ring-2 ring-primary border-primary bg-primary/5' : ''
        }`}
      onClick={() => {
        if (isSelectionMode && onToggleSelect) {
          onToggleSelect(account.id)
        }
      }}
    >
      <CardHeader className="relative">
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
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor}`} />
                <span className="truncate flex-1">{displayName}</span>
              </CardTitle>

              {account.email && account.email !== account.name && (
                <p className="text-sm text-muted-foreground mt-1 truncate">
                  {isPrivacyModeEnabled ? maskEmail(account.email) : account.email}
                </p>
              )}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 p-0" onClick={(e) => e.stopPropagation()}>
                  <span className="sr-only">Open menu</span>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleEdit}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleSync} disabled={loading}>
                  <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  Sync
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => repairAccount(account.id)} disabled={loading} className="cursor-pointer whitespace-nowrap">
                  <RefreshCw className={`mr-2 h-4 w-4 text-amber-500 shrink-0 ${loading ? 'animate-spin' : ''}`} />
                  Repair Account (Deep Refresh)
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={onDelete}
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
          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-muted-foreground">Last Refresh:</span>
            <span className="text-sm">{lastSyncText}</span>
          </div>
          {account.status === 'error' && (
            <div className="bg-destructive/10 border border-destructive/50 rounded-md p-3">
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

      <CardFooter>
        <Button
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation()
            navigate(`/account/${account.id}`)
          }}
          className="w-full"
        >
          View Addons
        </Button>
      </CardFooter>
    </Card>
  )
}
