import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
// import { Textarea } from '@/components/ui/textarea' 
import { getAddonGroupKey } from '@/lib/utils'
import { useAddonStore } from '@/store/addonStore'
import { useAccountStore } from '@/store/accountStore'
import { useProfileStore } from '@/store/profileStore'
import { StremioAccount } from '@/types/account'
import { BulkResult } from '@/types/saved-addon'
import { AlertTriangle, CheckCircle2, Copy, Globe, GripVertical, LayoutGrid, Library, Loader2, PlusCircle, ShieldAlert, ShieldCheck, Trash2, Zap, UserMinus, FileDown, Search, Tags, X } from 'lucide-react'
import { useState, useEffect } from 'react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'


interface BatchOperationsDialogProps {
  selectedAccounts: StremioAccount[]

  // We need all accounts for cloning (to pick source)
  // Ideally this component should receive them or fetch them. 
  // Let's assume the parent can pass them or we use a store. 
  // For now, let's limit "Cloning" to only be possible if we have access to the source account in the list?
  // Actually, the user might want to clone FROM an account that is NOT selected.
  // The 'selectedAccounts' are the TARGETS.
  // We need a list of 'potential sources'.
  allAccounts?: StremioAccount[]
  onClose: () => void
}
type BulkAction =
  | 'install-from-library'
  | 'add-saved-addons'
  | 'install-from-url'
  | 'clone-account'
  | 'update-addons'
  | 'reinstall-all'
  | 'protect-all'
  | 'unprotect-all'
  | 'remove-addons'
  | 'remove-by-tag'
  | 'sync-order'

const ACTION_TITLES: Record<BulkAction, string> = {
  'install-from-library': 'Install from Library',
  'add-saved-addons': 'Install Saved Addons',
  'install-from-url': 'Install from URLs',
  'clone-account': 'Mirror from Account',
  'sync-order': 'Sync Addon Order',
  'update-addons': 'Reinstall Addons',
  'remove-by-tag': 'Remove by Tags',
  'reinstall-all': 'Reinstall All',
  'remove-addons': 'Remove Addons',
  'protect-all': 'Protect All',
  'unprotect-all': 'Unprotect All'
}

export function BatchOperationsDialog({ selectedAccounts, allAccounts = [], onClose }: BatchOperationsDialogProps) {
  const {
    library,
    getAllTags,
    bulkApplySavedAddons,
    bulkRemoveAddons,
    bulkReinstallAddons,
    bulkInstallFromUrls,
    bulkCloneAccount,
    bulkRemoveByTag,
    bulkSyncOrder,
    loading,
  } = useAddonStore()
  const { bulkProtectAddons } = useAccountStore()
  const { profiles } = useProfileStore()

  const [action, setAction] = useState<BulkAction>('install-from-library')
  const [selectedSavedAddonIds, setSelectedSavedAddonIds] = useState<Set<string>>(new Set())
  const [selectedAddonIds, setSelectedAddonIds] = useState<Set<string>>(new Set())
  const [selectedUpdateAddonIds, setSelectedUpdateAddonIds] = useState<Set<string>>(new Set())
  const [selectedBulkTag, setSelectedBulkTag] = useState<string>('')

  // New State
  const [filterQuery, setFilterQuery] = useState('')
  const [urlList, setUrlList] = useState<string>('')
  const [sourceAccountId, setSourceAccountId] = useState<string>('')
  const [overwriteClone, setOverwriteClone] = useState(false)
  const [showProtected, setShowProtected] = useState(true)

  // Install from Library Profile State
  const [installMode, setInstallMode] = useState<'profile' | 'tag'>('profile')
  const [selectedInstallProfileId, setSelectedInstallProfileId] = useState<string>('')
  const [selectedInstallTagName, setSelectedInstallTagName] = useState<string>('')

  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [result, setResult] = useState<BulkResult | null>(null)

  useEffect(() => {
    setSelectedSavedAddonIds(new Set())
    setSelectedAddonIds(new Set())
    setSelectedUpdateAddonIds(new Set())
    setSelectedBulkTag('')
    setFilterQuery('') // Reset filter on action switch
    setError(null)
  }, [action])

  const sortedSavedAddons = Object.values(library)
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(a => {
      if (!filterQuery) return true
      return a.name.toLowerCase().includes(filterQuery.toLowerCase()) ||
        a.manifest.name.toLowerCase().includes(filterQuery.toLowerCase())
    })

  const allTags = getAllTags()

  const currentTagAddonsCount = selectedInstallTagName
    // filtering logic for tags doesn't need search, but maybe? 
    // Let's leave tag count logic as is for now
    ? Object.values(library).filter((addon: any) => addon.tags.includes(selectedInstallTagName)).length
    : 0

  const isTagAction = action === 'install-from-library' && installMode === 'tag'
  const isInvalidTag = isTagAction && selectedInstallTagName !== '' && currentTagAddonsCount === 0

  // Collect all unique addons across selected accounts, and track which accounts have them
  // We key by canonical URL to correctly group UUID-based configurations of the same addon
  const allAddonsMap = new Map<string, { addon: any, accounts: StremioAccount[] }>()

  selectedAccounts.forEach((acc: StremioAccount) => {
    acc.addons.forEach((addon: any) => {
      const key = getAddonGroupKey(addon)
      if (!allAddonsMap.has(key)) {
        allAddonsMap.set(key, { addon, accounts: [] })
      }
      allAddonsMap.get(key)?.accounts.push(acc)
    })
  })

  // Convert to array and sort
  const allAddonsRaw = Array.from(allAddonsMap.values())
    .sort((a, b) => a.addon.manifest.name.localeCompare(b.addon.manifest.name))

  const allAddons = (showProtected
    ? allAddonsRaw
    : allAddonsRaw.filter(item => !item.addon.flags?.protected)
  ).filter(item => {
    if (!filterQuery) return true
    return item.addon.manifest.name.toLowerCase().includes(filterQuery.toLowerCase())
  })

  const toggleSavedAddon = (savedAddonId: string) => {
    setSelectedSavedAddonIds((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(savedAddonId)) {
        newSet.delete(savedAddonId)
      } else {
        newSet.add(savedAddonId)
      }
      return newSet
    })
  }

  const toggleAddon = (addonId: string) => {
    setSelectedAddonIds((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(addonId)) {
        newSet.delete(addonId)
      } else {
        newSet.add(addonId)
      }
      return newSet
    })
  }

  const handleExecute = async () => {
    setError(null)
    setSuccess(false)

    const accountsData = selectedAccounts.map((a: StremioAccount) => ({
      id: a.id,
      authKey: a.authKey,
    }))

    try {
      let bulkResult

      switch (action) {
        case 'remove-by-tag':
          if (!selectedBulkTag) {
            setError('Please select a tag')
            return
          }
          bulkResult = await bulkRemoveByTag(selectedBulkTag, accountsData)
          break

        case 'add-saved-addons':
          if (selectedSavedAddonIds.size === 0) {
            setError('Please select at least one saved addon')
            return
          }
          bulkResult = await bulkApplySavedAddons(
            Array.from(selectedSavedAddonIds),
            accountsData,
            true // allowProtected override
          )
          break

        /* Duplicate removed */

        case 'remove-addons':
          if (selectedAddonIds.size === 0) {
            setError('Please select at least one addon to remove')
            return
          }
          bulkResult = await bulkRemoveAddons(Array.from(selectedAddonIds), accountsData, true)
          break

        /* Duplicate removed */

        case 'update-addons':
          if (selectedUpdateAddonIds.size === 0) {
            setError('Please select at least one addon to update')
            return
          }
          bulkResult = await bulkReinstallAddons(Array.from(selectedUpdateAddonIds), accountsData, true)
          break

        case 'install-from-url': {
          const urls = urlList.split('\n').map(u => u.trim()).filter(u => u.length > 0)
          if (urls.length === 0) {
            setError('Please enter at least one URL')
            return
          }
          bulkResult = await bulkInstallFromUrls(urls, accountsData, true)
          break
        }

        case 'clone-account': {
          if (!sourceAccountId) {
            setError('Please select a source account')
            return
          }
          const sourceAccount = allAccounts.find(a => a.id === sourceAccountId)
          if (!sourceAccount) {
            setError('Source account not found')
            return
          }
          bulkResult = await bulkCloneAccount(
            { id: sourceAccount.id, authKey: sourceAccount.authKey },
            accountsData,
            overwriteClone
          )
          break
        }
        case 'sync-order': {
          if (!sourceAccountId) {
            setError('Please select a source account')
            return
          }
          // Validate source is in allAccounts for safety, though ID check is enough
          if (!allAccounts.find(a => a.id === sourceAccountId)) {
            setError('Source account not found')
            return
          }
          bulkResult = await bulkSyncOrder(sourceAccountId, accountsData)
          break
        }
        case 'protect-all':
          for (const acc of selectedAccounts) {
            await bulkProtectAddons(acc.id, true)
          }
          bulkResult = { success: selectedAccounts.length, failed: 0, errors: [], details: [] }
          break
        case 'unprotect-all':
          for (const acc of selectedAccounts) {
            await bulkProtectAddons(acc.id, false)
          }
          bulkResult = { success: selectedAccounts.length, failed: 0, errors: [], details: [] }
          break
        case 'reinstall-all':
          bulkResult = await bulkReinstallAddons(['*'], accountsData)
          break
        case 'install-from-library': {
          const libraryArray = Object.values(library)
          let addonsToInstall: any[] = []
          if (installMode === 'profile' && selectedInstallProfileId) {
            addonsToInstall = selectedInstallProfileId === 'unassigned'
              ? libraryArray.filter(a => !a.profileId)
              : libraryArray.filter(a => a.profileId === selectedInstallProfileId)
          } else if (installMode === 'tag' && selectedInstallTagName) {
            addonsToInstall = libraryArray.filter(a => a.tags.includes(selectedInstallTagName))
          }

          if (addonsToInstall.length === 0) {
            setError('No addons found in the selected group')
            return
          }

          bulkResult = await bulkApplySavedAddons(
            addonsToInstall.map(a => a.id),
            accountsData,
            true // unrestricted
          )
          break
        }
      }

      if (!bulkResult) {
        throw new Error('Action failed or not implemented')
      }

      setResult(bulkResult!)
      setSuccess(true)

      if (bulkResult?.failed === 0 && !bulkResult.details.some(d => (d.result as any).skipped?.length ?? 0)) {
        setTimeout(() => {
          onClose()
        }, 2000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed')
    }
  }

  return (
    <div className="space-y-6 py-4">
      {/* Success Message */}
      {success && result && (
        <div className={`p-3 rounded-md border animate-in fade-in slide-in-from-top-2 ${result.details.some(d => (d.result as any).skipped?.length > 0) || result.failed > 0
          ? "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800"
          : "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"
          }`}>
          <div className="flex flex-col gap-1">
            <p className={`text-sm font-medium flex items-center gap-2 ${result.failed > 0
              ? "text-amber-600 dark:text-amber-400"
              : "text-green-600 dark:text-green-400"
              }`}>
              <CheckCircle2 className="h-4 w-4" />
              Done, applied to {result.success} account{result.success !== 1 ? 's' : ''}
              {result.failed > 0 && ` (${result.failed} failed)`}
            </p>
            {/* Show skipped/protected summary */}
            {result.details.some(d => (d.result as any).skipped?.length > 0) && (
              <p className="text-xs text-muted-foreground ml-6">
                Info: {result.details.reduce((acc, d) => acc + (d.result as any).added?.length, 0)} installed.
                {' '}
                {result.details.reduce((acc, d) => acc + ((d.result as any).skipped?.length || 0), 0)} items were skipped or failed.
              </p>
            )}
            {result.details.some(d => d.result.protected?.length > 0) && (
              <p className="text-xs text-muted-foreground ml-6">
                Info: {result.details.reduce((acc, d) => acc + (d.result.protected?.length || 0), 0)} protected addons were preserved.
              </p>
            )}
            {/* Show failed accounts summary */}
            {result.errors.length > 0 && (
              <ul className="text-xs text-destructive ml-6 list-disc">
                {result.errors.map((e, i) => (
                  <li key={i}>Account {e.accountId.substring(0, 8)}...: {e.error}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="p-3 rounded-md bg-destructive/10 border border-destructive/50 animate-in fade-in slide-in-from-top-2">
          <p className="text-sm text-destructive font-medium">{error}</p>
        </div>
      )}

      <div className="flex flex-col gap-6">
        {/* Action Selector Card */}
        <Card className="border shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 uppercase tracking-wide text-muted-foreground">
              <LayoutGrid className="h-4 w-4" />
              Operation Mode
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="action-select">I want to...</Label>
              <Select value={action} onValueChange={(v) => setAction(v as BulkAction)}>
                <SelectTrigger id="action-select" className="bg-background">
                  <SelectValue placeholder="What should we do?" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Installation & Deployment</SelectLabel>
                    <SelectItem value="install-from-library" className="focus:bg-primary/10">
                      <div className="flex items-center gap-2">
                        <Library className="h-4 w-4 text-primary" />
                        <div className="text-left">
                          <p className="font-medium">Install from Library</p>
                          <p className="text-[10px] text-muted-foreground">Apply profiles or tags across accounts</p>
                        </div>
                      </div>
                    </SelectItem>

                    <SelectItem value="add-saved-addons" className="focus:bg-primary/10">
                      <div className="flex items-center gap-2">
                        <PlusCircle className="h-4 w-4 text-emerald-500" />
                        <div className="text-left">
                          <p className="font-medium">Install Saved Addons</p>
                          <p className="text-[10px] text-muted-foreground">Select individual saved addons to install</p>
                        </div>
                      </div>
                    </SelectItem>

                    <SelectItem value="install-from-url" className="focus:bg-primary/10">
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-blue-500" />
                        <div className="text-left">
                          <p className="font-medium">Install from URLs</p>
                          <p className="text-[10px] text-muted-foreground">Paste addon URLs, one per line</p>
                        </div>
                      </div>
                    </SelectItem>
                  </SelectGroup>

                  <SelectGroup>
                    <SelectLabel>Account Synchronization</SelectLabel>
                    <SelectItem value="clone-account" className="focus:bg-primary/10">
                      <div className="flex items-center gap-2">
                        <Copy className="h-4 w-4 text-amber-500" />
                        <div className="text-left">
                          <p className="font-medium">Mirror from Account</p>
                          <p className="text-[10px] text-muted-foreground">Copy all addons from one account to many</p>
                        </div>
                      </div>
                    </SelectItem>

                    <SelectItem value="sync-order" className="focus:bg-primary/10">
                      <div className="flex items-center gap-2">
                        <GripVertical className="h-4 w-4 text-purple-500" />
                        <div className="text-left">
                          <p className="font-medium">Sync Addon Order</p>
                          <p className="text-[10px] text-muted-foreground">Reorder addons on targets to match source</p>
                        </div>
                      </div>
                    </SelectItem>
                  </SelectGroup>

                  <SelectGroup>
                    <SelectLabel>Mass Management</SelectLabel>
                    <SelectItem value="update-addons" className="focus:bg-primary/10">
                      <div className="flex items-center gap-2">
                        <FileDown className="h-4 w-4 text-blue-500" />
                        <div className="text-left">
                          <p className="font-medium">Reinstall Addons</p>
                          <p className="text-[10px] text-muted-foreground">Reinstall selected addons from source URL</p>
                        </div>
                      </div>
                    </SelectItem>

                    <SelectItem value="remove-by-tag" className="focus:bg-primary/10">
                      <div className="flex items-center gap-2">
                        <UserMinus className="h-4 w-4 text-orange-500" />
                        <div className="text-left">
                          <p className="font-medium">Remove by Tags</p>
                          <p className="text-[10px] text-muted-foreground">Remove all addons with a matching tag</p>
                        </div>
                      </div>
                    </SelectItem>

                    <SelectItem value="reinstall-all" className="focus:bg-primary/10">
                      <div className="flex items-center gap-2">
                        <Zap className="h-4 w-4 text-emerald-500" />
                        <div className="text-left">
                          <p className="font-medium">Reinstall All</p>
                          <p className="text-[10px] text-muted-foreground">Force refresh every addon on accounts</p>
                        </div>
                      </div>
                    </SelectItem>

                    <SelectItem value="remove-addons" className="focus:bg-primary/10">
                      <div className="flex items-center gap-2">
                        <Trash2 className="h-4 w-4 text-destructive" />
                        <div className="text-left">
                          <p className="font-medium">Remove Addons</p>
                          <p className="text-[10px] text-muted-foreground">Delete specific addons from account</p>
                        </div>
                      </div>
                    </SelectItem>
                  </SelectGroup>

                  <SelectGroup>
                    <SelectLabel>Access Control</SelectLabel>
                    <SelectItem value="protect-all" className="focus:bg-primary/10">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-blue-500" />
                        <div className="text-left">
                          <p className="font-medium">Protect All</p>
                          <p className="text-[10px] text-muted-foreground">Enable protection for all addons</p>
                        </div>
                      </div>
                    </SelectItem>

                    <SelectItem value="unprotect-all" className="focus:bg-primary/10">
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                        <div className="text-left">
                          <p className="font-medium">Unprotect All</p>
                          <p className="text-[10px] text-muted-foreground">Disable protection for all addons</p>
                        </div>
                      </div>
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card className="border shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 uppercase tracking-wide text-muted-foreground">
              {action.includes('tag') ? <Tags className="h-4 w-4" /> :
                action.includes('remove') ? <Trash2 className="h-4 w-4" /> :
                  action === 'update-addons' ? <FileDown className="h-4 w-4" /> :
                    action === 'install-from-url' ? <Globe className="h-4 w-4" /> :
                      action === 'clone-account' ? <Copy className="h-4 w-4" /> :
                        action === 'sync-order' ? <GripVertical className="h-4 w-4" /> :
                          action === 'protect-all' ? <ShieldCheck className="h-4 w-4" /> :
                            action === 'unprotect-all' ? <ShieldAlert className="h-4 w-4" /> :
                              action === 'install-from-library' ? <Library className="h-4 w-4 text-primary" /> :
                                <PlusCircle className="h-4 w-4" />}
              {ACTION_TITLES[action]}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Add Saved Addons */}
            {action === 'add-saved-addons' && (
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <Label>Select Saved Addons</Label>
                  <div className="flex gap-3 items-center w-full sm:w-auto">
                    <div className="relative flex-1 sm:w-32">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      <Input
                        placeholder="Filter..."
                        className="h-7 text-xs pl-7 pr-7"
                        value={filterQuery}
                        onChange={e => setFilterQuery(e.target.value)}
                      />
                      {filterQuery && (
                        <button
                          onClick={() => setFilterQuery('')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-accent rounded-full transition-colors"
                        >
                          <X className="h-2 w-2 text-muted-foreground" />
                        </button>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-primary px-2"
                        onClick={() => setSelectedSavedAddonIds(new Set(sortedSavedAddons.map(a => a.id)))}
                      >
                        All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-muted-foreground px-2"
                        onClick={() => setSelectedSavedAddonIds(new Set())}
                      >
                        None
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="border rounded-md max-h-60 overflow-y-auto bg-background">
                  {sortedSavedAddons.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-8 text-center italic">
                      No saved addons in your library.
                    </p>
                  ) : (
                    <div className="divide-y">
                      {sortedSavedAddons.map((savedAddon) => (
                        <label
                          key={savedAddon.id}
                          className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            className="rounded border-gray-300 text-primary focus:ring-primary"
                            checked={selectedSavedAddonIds.has(savedAddon.id)}
                            onChange={() => toggleSavedAddon(savedAddon.id)}
                          />
                          {savedAddon.metadata?.customLogo || savedAddon.manifest.logo ? (
                            <img
                              src={savedAddon.metadata?.customLogo || savedAddon.manifest.logo}
                              alt={savedAddon.name}
                              className="w-8 h-8 rounded object-contain flex-shrink-0 bg-transparent"
                              onError={(e) => { e.currentTarget.style.display = 'none' }}
                            />
                          ) : (
                            <div className="w-8 h-8 rounded bg-muted flex items-center justify-center flex-shrink-0">
                              <span className="text-xs text-muted-foreground">📦</span>
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium truncate">{savedAddon.name}</p>
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{savedAddon.manifest.name}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* UI for Library Install (Polished) */}
            {action === 'install-from-library' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-1.5 px-1">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">Installation Source</p>
                  <div className="flex bg-muted/50 p-1 rounded-xl gap-1 border border-border/50">
                    <Button
                      variant={installMode === 'profile' ? 'secondary' : 'ghost'}
                      className={`flex-1 h-9 text-xs transition-all duration-200 rounded-lg ${installMode === 'profile' ? 'shadow-sm bg-background hover:bg-background' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => setInstallMode('profile')}
                      type="button"
                    >
                      <Library className={`h-3.5 w-3.5 mr-2 ${installMode === 'profile' ? 'text-primary' : ''}`} />
                      Profiles
                    </Button>
                    <Button
                      variant={installMode === 'tag' ? 'secondary' : 'ghost'}
                      className={`flex-1 h-9 text-xs transition-all duration-200 rounded-lg ${installMode === 'tag' ? 'shadow-sm bg-background hover:bg-background' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => setInstallMode('tag')}
                      type="button"
                    >
                      <Tags className={`h-3.5 w-3.5 mr-2 ${installMode === 'tag' ? 'text-primary' : ''}`} />
                      Tags
                    </Button>
                  </div>
                </div>

                {installMode === 'profile' ? (
                  <div className="space-y-3 animate-in fade-in duration-300">
                    <div className="space-y-1.5 px-1">
                      <Label className="text-[10px] font-bold uppercase text-muted-foreground/70 tracking-wider">Select Library Profile</Label>
                      <Select value={selectedInstallProfileId} onValueChange={setSelectedInstallProfileId}>
                        <SelectTrigger className="bg-background/50 border-border/50 h-10">
                          <SelectValue placeholder="Choose a profile..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unassigned">
                            <div className="flex items-center gap-2">
                              <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
                              <span>Unassigned Addons</span>
                            </div>
                          </SelectItem>
                          {profiles.map(p => (
                            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 animate-in fade-in duration-300">
                    <div className="space-y-1.5 px-1">
                      <Label className="text-[10px] font-bold uppercase text-muted-foreground/70 tracking-wider">Select Library Tag</Label>
                      <Select value={selectedInstallTagName} onValueChange={setSelectedInstallTagName}>
                        <SelectTrigger className="bg-background/50 border-border/50 h-10">
                          <SelectValue placeholder="Choose a tag..." />
                        </SelectTrigger>
                        <SelectContent>
                          {allTags.map(tag => (
                            <SelectItem key={tag} value={tag}>
                              <div className="flex items-center gap-2">
                                <Tags className="h-3.5 w-3.5 text-primary/60" />
                                <span>{tag}</span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                {/* Preview Addons */}
                {((installMode === 'profile' && selectedInstallProfileId) || (installMode === 'tag' && selectedInstallTagName)) && (
                  <div className="p-3 rounded-lg bg-primary/5 border border-primary/10 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-primary/70">
                      Addons to Install
                    </p>
                    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                      {(installMode === 'profile'
                        ? (selectedInstallProfileId === 'unassigned' ? Object.values(library).filter(a => !a.profileId) : Object.values(library).filter(a => a.profileId === selectedInstallProfileId))
                        : Object.values(library).filter(a => a.tags.includes(selectedInstallTagName))
                      ).map(addon => (
                        <div key={addon.id} className="text-[10px] px-2 py-0.5 bg-background border rounded flex items-center gap-1.5">
                          {addon.manifest.logo && <img src={addon.manifest.logo} className="w-3 h-3 object-contain" alt="" />}
                          <span className="truncate max-w-[120px]">{addon.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Install from URL */}
            {action === 'install-from-url' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Manifest URLs</Label>
                  <p className="text-xs text-muted-foreground">
                    Paste addon manifest URLs here, one per line. They will be fetched and installed on all selected accounts.
                  </p>
                  <textarea
                    className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    placeholder="https://v3-cinemeta.strem.io/manifest.json&#10;https://opensubtitles.strem.io/manifest.json"
                    value={urlList}
                    onChange={(e) => setUrlList(e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* Clone Account UI (Reused for Sync Order) */}
            {(action === 'clone-account' || action === 'sync-order') && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Source Account</Label>
                  <Select value={sourceAccountId} onValueChange={setSourceAccountId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select account to copy from..." />
                    </SelectTrigger>
                    <SelectContent>
                      {allAccounts
                        .filter(acc => !selectedAccounts.some(s => s.id === acc.id))
                        .map((acc) => (
                          <SelectItem key={acc.id} value={acc.id}>
                            <div className="flex items-center gap-2">
                              {acc.emoji && <span className="text-base shrink-0">{acc.emoji}</span>}
                              <span>{acc.name !== acc.email ? acc.name : acc.email}</span>
                            </div>
                          </SelectItem>
                        ))}
                      {allAccounts.filter(acc => !selectedAccounts.some(s => s.id === acc.id)).length === 0 && (
                        <SelectItem value="none" disabled>No other accounts available</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {action === 'clone-account'
                      ? "All addons from this account will be copied to the selected targets."
                      : "The target accounts will be reordered to match this account's addon list. No addons will be added or removed."}
                  </p>
                </div>

                {action === 'clone-account' && (
                  <>
                    <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-dashed mt-4 animate-in fade-in slide-in-from-top-2">
                      <div className="space-y-0.5">
                        <Label className="text-sm font-semibold flex items-center gap-2">
                          Overwrite Mode
                          {overwriteClone && <AlertTriangle className="h-3 w-3 text-amber-500" />}
                        </Label>
                        <p className="text-[11px] text-muted-foreground leading-relaxed pr-8">
                          Wipe all non-protected addons on target accounts before copying from source. Use with caution.
                        </p>
                      </div>
                      <Switch
                        checked={overwriteClone}
                        onCheckedChange={setOverwriteClone}
                        className="data-[state=checked]:bg-destructive"
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Remove by Tag */}
            {action === 'remove-by-tag' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Select Tag to Remove</Label>
                  <Select value={selectedBulkTag} onValueChange={setSelectedBulkTag}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a tag..." />
                    </SelectTrigger>
                    <SelectContent>
                      {allTags.map(tag => (
                        <SelectItem key={tag} value={tag}>
                          <div className="flex items-center gap-2">
                            <Tags className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>{tag}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    All addons in your library with this tag will be removed from the selected accounts.
                  </p>
                </div>

                {selectedBulkTag && (
                  <div className="p-3 rounded-lg bg-destructive/5 border border-destructive/10 space-y-2 animate-in fade-in slide-in-from-top-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-destructive/70 flex items-center gap-2">
                      <Trash2 className="h-3 w-3" />
                      Addons to be Removed
                    </p>
                    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                      {Object.values(library)
                        .filter(a => a.tags.includes(selectedBulkTag))
                        .map(addon => (
                          <div key={addon.id} className="text-[10px] px-2 py-0.5 bg-background border rounded flex items-center gap-1.5 opacity-70">
                            {addon.manifest.logo && <img src={addon.manifest.logo} className="w-3 h-3 object-contain" alt="" />}
                            <span className="truncate max-w-[120px]">{addon.name}</span>
                          </div>
                        ))}
                      {Object.values(library).filter(a => a.tags.includes(selectedBulkTag)).length === 0 && (
                        <span className="text-[10px] text-muted-foreground italic">No addons found with this tag.</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Remove Addons */}
            {action === 'remove-addons' && (
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-card p-1 gap-3">
                  <div className="space-y-0.5">
                    <Label>Select Addons to Remove</Label>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="show-prot-remove"
                        checked={showProtected}
                        onCheckedChange={setShowProtected}
                      />
                      <span className="text-[10px] text-muted-foreground">Show Protected</span>
                    </div>
                  </div>
                  <div className="flex gap-2 items-center w-full sm:w-auto">
                    <div className="relative flex-1 sm:w-32">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      <Input
                        placeholder="Filter..."
                        className="h-7 text-xs pl-7"
                        value={filterQuery}
                        onChange={e => setFilterQuery(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-primary px-2"
                        onClick={() => setSelectedAddonIds(new Set(allAddons.map(i => i.addon.transportUrl)))}
                      >
                        All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-muted-foreground px-2"
                        onClick={() => setSelectedAddonIds(new Set())}
                      >
                        None
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="border rounded-md max-h-60 overflow-y-auto bg-background">
                  {allAddons.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-8 text-center italic">No installed addons found on selected accounts.</p>
                  ) : (
                    <div className="divide-y">
                      {allAddons.map((item) => (
                        <label
                          key={item.addon.transportUrl}
                          className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            className="rounded border-gray-300 text-destructive focus:ring-destructive"
                            checked={selectedAddonIds.has(item.addon.transportUrl)}
                            onChange={() => toggleAddon(item.addon.transportUrl)}
                          />
                          {(item.addon.manifest.logo) ? (
                            <img
                              src={item.addon.manifest.logo}
                              alt={item.addon.manifest.name}
                              className="w-8 h-8 rounded object-contain flex-shrink-0 bg-transparent"
                              onError={(e) => { e.currentTarget.style.display = 'none' }}
                            />
                          ) : (
                            <div className="w-8 h-8 rounded bg-muted flex items-center justify-center flex-shrink-0">
                              <span className="text-xs text-muted-foreground">📦</span>
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium truncate">
                                {item.addon.manifest.name}
                                {allAddons.filter(a => a.addon.manifest.name === item.addon.manifest.name).length > 1 && (
                                  <span className="text-xs text-muted-foreground ml-1 font-normal opacity-70">
                                    ({item.addon.transportUrl.slice(-6)})
                                  </span>
                                )}
                              </p>
                              {(item.addon.flags?.protected || item.addon.flags?.official) && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${item.addon.flags?.protected
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                  : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                  }`}>
                                  {item.addon.flags?.protected ? 'Protected' : 'Official'}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs text-muted-foreground truncate font-mono">{item.addon.manifest.id}</p>
                              <span className="text-[10px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded truncate max-w-[120px]">
                                {item.accounts.length === selectedAccounts.length ? 'All selected' : item.accounts.map(a => a.name || 'Unknown').join(', ')}
                              </span>
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Remove by Tags handled via unified Library UI or pick manually */}

            {/* Update Addons */}
            {action === 'update-addons' && (
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-card p-1 gap-3">
                  <div className="space-y-0.5">
                    <Label>Select Addons to Update</Label>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="show-prot-update"
                        checked={showProtected}
                        onCheckedChange={setShowProtected}
                      />
                      <span className="text-[10px] text-muted-foreground">Show Protected</span>
                    </div>
                  </div>
                  <div className="flex gap-2 items-center w-full sm:w-auto">
                    <div className="relative flex-1 sm:w-32">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      <Input
                        placeholder="Filter..."
                        className="h-7 text-xs pl-7"
                        value={filterQuery}
                        onChange={e => setFilterQuery(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-primary px-2"
                        onClick={() => setSelectedUpdateAddonIds(new Set(allAddons.map(i => i.addon.transportUrl)))}
                      >
                        All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-muted-foreground px-2"
                        onClick={() => setSelectedUpdateAddonIds(new Set())}
                      >
                        None
                      </Button>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mb-2">
                  Re-installs selected addons from their source URL to get the latest version.
                </p>
                <div className="border rounded-md max-h-60 overflow-y-auto bg-background">
                  {allAddons.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-8 text-center italic">No addons available.</p>
                  ) : (
                    <div className="divide-y">
                      {allAddons.map((item) => (
                        <label
                          key={item.addon.transportUrl}
                          className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            className="rounded border-gray-300 text-primary focus:ring-primary"
                            checked={selectedUpdateAddonIds.has(item.addon.transportUrl)}
                            onChange={() => {
                              setSelectedUpdateAddonIds((prev) => {
                                const newSet = new Set(prev)
                                if (newSet.has(item.addon.transportUrl)) {
                                  newSet.delete(item.addon.transportUrl)
                                } else {
                                  newSet.add(item.addon.transportUrl)
                                }
                                return newSet
                              })
                            }}
                          />
                          {(item.addon.manifest.logo) ? (
                            <img
                              src={item.addon.manifest.logo}
                              alt={item.addon.manifest.name}
                              className="w-8 h-8 rounded object-contain flex-shrink-0 bg-transparent"
                              onError={(e) => { e.currentTarget.style.display = 'none' }}
                            />
                          ) : (
                            <div className="w-8 h-8 rounded bg-muted flex items-center justify-center flex-shrink-0">
                              <span className="text-xs text-muted-foreground">📦</span>
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium truncate">
                                {item.addon.manifest.name}
                                {allAddons.filter(a => a.addon.manifest.name === item.addon.manifest.name).length > 1 && (
                                  <span className="text-xs text-muted-foreground ml-1 font-normal opacity-70">
                                    ({item.addon.transportUrl.slice(-6)})
                                  </span>
                                )}
                              </p>
                              {(item.addon.flags?.protected || item.addon.flags?.official) && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${item.addon.flags?.protected
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                  : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                  }`}>
                                  {item.addon.flags?.protected ? 'Protected' : 'Official'}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs text-muted-foreground truncate">v{item.addon.manifest.version}</p>
                              <span className="text-[10px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded truncate max-w-[120px]">
                                {item.accounts.length === selectedAccounts.length ? 'All selected' : item.accounts.map(a => a.name || 'Unknown').join(', ')}
                              </span>
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Reinstall All / Protect / Unprotect All */}
            {(action === 'protect-all' || action === 'unprotect-all' || action === 'reinstall-all') && (
              <div className="space-y-4">
                <div className="p-4 rounded-lg bg-muted/30 border border-dashed text-center">
                  <p className="text-sm font-medium">
                    {action === 'reinstall-all'
                      ? `This will REINSTALL ALL addons on the ${selectedAccounts.length} selected accounts.`
                      : `This will ${action === 'protect-all' ? 'enable' : 'disable'} protection for ALL addons on the ${selectedAccounts.length} selected accounts.`
                    }
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {action === 'reinstall-all'
                      ? 'Re-installs every addon from its source URL. Useful for clearing glitches or forcing updates.'
                      : 'Protected addons cannot be removed or modified unless protection is disabled.'
                    }
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        {/* Blast Radius Preview */}
        {!success && (
          <div className="bg-muted/30 border border-dashed rounded-lg p-3 space-y-2">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3" />
              Impact Summary (Blast Radius)
            </h4>
            <div className="text-xs space-y-1">
              {action === 'install-from-library' && (
                <p>Will install <b>{installMode === 'profile' ? sortedSavedAddons.filter(a => selectedInstallProfileId === 'unassigned' ? !a.profileId : a.profileId === selectedInstallProfileId).length : sortedSavedAddons.filter(a => a.tags.includes(selectedInstallTagName)).length}</b> addons across <b>{selectedAccounts.length}</b> account{selectedAccounts.length !== 1 ? 's' : ''}.</p>
              )}
              {action === 'add-saved-addons' && (
                <p>Will install <b>{selectedSavedAddonIds.size}</b> selected addon{selectedSavedAddonIds.size !== 1 ? 's' : ''} across <b>{selectedAccounts.length}</b> account{selectedAccounts.length !== 1 ? 's' : ''}.</p>
              )}
              {action === 'install-from-url' && (
                <p>Will install <b>{urlList.split('\n').filter(u => u.trim()).length}</b> addon{urlList.split('\n').filter(u => u.trim()).length !== 1 ? 's' : ''} from URLs across <b>{selectedAccounts.length}</b> account{selectedAccounts.length !== 1 ? 's' : ''}.</p>
              )}
              {action === 'clone-account' && (
                <p>Will <b>{overwriteClone ? 'REPLACE' : 'SYNC'}</b> addons from source to <b>{selectedAccounts.length}</b> account{selectedAccounts.length !== 1 ? 's' : ''}.</p>
              )}
              {action === 'update-addons' && (
                <p>Will reinstall <b>{selectedUpdateAddonIds.size}</b> selected addon{selectedUpdateAddonIds.size !== 1 ? 's' : ''} across <b>{selectedAccounts.length}</b> account{selectedAccounts.length !== 1 ? 's' : ''}.</p>
              )}
              {action === 'remove-by-tag' && (
                <p>Will remove all addons with tag <b>'{selectedBulkTag}'</b> from <b>{selectedAccounts.length}</b> account{selectedAccounts.length !== 1 ? 's' : ''}.</p>
              )}
              {action === 'reinstall-all' && (
                <p className="text-amber-600 font-medium">⚠️ Will REINSTALL EVERY addon on <b>{selectedAccounts.length}</b> account{selectedAccounts.length !== 1 ? 's' : ''}.</p>
              )}
              {(action === 'protect-all' || action === 'unprotect-all') && (
                <p>Will <b>{action === 'protect-all' ? 'ENABLE' : 'DISABLE'}</b> protection for ALL addons on <b>{selectedAccounts.length}</b> account{selectedAccounts.length !== 1 ? 's' : ''}.</p>
              )}
              {action === 'remove-addons' && (
                <p className="text-destructive font-medium">⚠️ Will REMOVE <b>{selectedAddonIds.size}</b> unique addon{selectedAddonIds.size !== 1 ? 's' : ''} from <b>{selectedAccounts.length}</b> account{selectedAccounts.length !== 1 ? 's' : ''}.</p>
              )}
              <p className="text-[10px] text-muted-foreground italic pt-1 border-t border-muted-foreground/10 mt-1">
                Total operations: <b>{selectedAccounts.length}</b>
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          className="flex-1"
        >
          {success ? 'Close' : 'Cancel'}
        </Button>
        <Button
          onClick={handleExecute}
          disabled={loading || success || isInvalidTag}
          className="flex-1"
          type="button"
        >
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {success ? 'Done' : 'Execute'}
        </Button>
      </div>
    </div >
  )
}
