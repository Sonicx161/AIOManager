import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
// import { Textarea } from '@/components/ui/textarea' 
import { useAddonStore } from '@/store/addonStore'
import { useAccountStore } from '@/store/accountStore'
import { StremioAccount } from '@/types/account'
import { BulkResult } from '@/types/saved-addon'
import { Copy, Globe, LayoutGrid, Loader2, PlusCircle, RefreshCw, Tags, Trash2, AlertTriangle, Shield, ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { Switch } from '@/components/ui/switch'

interface BulkActionsDialogProps {
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
  | 'add-saved-addons'
  | 'add-by-tag'
  | 'remove-addons'
  | 'remove-by-tag'
  | 'update-addons'
  | 'install-from-url'
  | 'clone-account'
  | 'protect-all'
  | 'unprotect-all'

export function BulkActionsDialog({ selectedAccounts, allAccounts = [], onClose }: BulkActionsDialogProps) {
  const {
    library,
    getAllTags,
    bulkApplySavedAddons,
    bulkApplyTag,
    bulkRemoveAddons,
    bulkRemoveByTag,
    bulkReinstallAddons,
    bulkInstallFromUrls,
    bulkCloneAccount,
    loading,
  } = useAddonStore()
  const { bulkProtectAddons } = useAccountStore()

  const [action, setAction] = useState<BulkAction>('add-saved-addons')
  const [selectedSavedAddonIds, setSelectedSavedAddonIds] = useState<Set<string>>(new Set())
  const [selectedTag, setSelectedTag] = useState<string>('')
  const [selectedAddonIds, setSelectedAddonIds] = useState<Set<string>>(new Set())
  const [selectedUpdateAddonIds, setSelectedUpdateAddonIds] = useState<Set<string>>(new Set())

  // New State
  const [urlList, setUrlList] = useState<string>('')
  const [sourceAccountId, setSourceAccountId] = useState<string>('')
  const [overwriteClone, setOverwriteClone] = useState(false)
  const [showProtected, setShowProtected] = useState(true)

  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [result, setResult] = useState<BulkResult | null>(null)

  const savedAddons = Object.values(library).sort((a, b) => a.name.localeCompare(b.name))
  const allTags = getAllTags()

  const currentTagAddonsCount = selectedTag
    ? savedAddons.filter((addon) => addon.tags.includes(selectedTag)).length
    : 0

  const isTagAction = action === 'add-by-tag' || action === 'remove-by-tag'
  const isInvalidTag = isTagAction && selectedTag !== '' && currentTagAddonsCount === 0

  // Collect all unique addons across selected accounts, and sort alphabetically
  const allAddonsRaw = Array.from(
    new Map(
      selectedAccounts.flatMap((acc) =>
        acc.addons
          .map((addon) => [addon.manifest.id, addon])
      )
    ).values()
  ).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))

  const allAddons = showProtected
    ? allAddonsRaw
    : allAddonsRaw.filter(a => !a.flags?.protected)

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

    const accountsData = selectedAccounts.map((a) => ({
      id: a.id,
      authKey: a.authKey,
    }))

    try {
      let bulkResult

      switch (action) {
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

        case 'add-by-tag':
          if (!selectedTag) {
            setError('Please select a tag')
            return
          }
          bulkResult = await bulkApplyTag(selectedTag, accountsData)
          break

        case 'remove-addons':
          if (selectedAddonIds.size === 0) {
            setError('Please select at least one addon to remove')
            return
          }
          bulkResult = await bulkRemoveAddons(Array.from(selectedAddonIds), accountsData, true)
          break

        case 'remove-by-tag':
          if (!selectedTag) {
            setError('Please select a tag')
            return
          }
          bulkResult = await bulkRemoveByTag(selectedTag, accountsData, true)
          break

        case 'update-addons':
          if (selectedUpdateAddonIds.size === 0) {
            setError('Please select at least one addon to update')
            return
          }
          bulkResult = await bulkReinstallAddons(Array.from(selectedUpdateAddonIds), accountsData)
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
      }

      setResult(bulkResult!)
      setSuccess(true)

      if (bulkResult?.failed === 0 && !bulkResult.details.some(d => d.result.skipped?.length > 0 || 0)) {
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
              <Loader2 className="h-4 w-4" />
              Operation completed on {result.success} account{result.success !== 1 ? 's' : ''}
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
              Select Action
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="action-select">I want to...</Label>
              <Select value={action} onValueChange={(v) => setAction(v as BulkAction)}>
                <SelectTrigger id="action-select" className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="add-saved-addons">
                    <div className="flex items-center gap-2">
                      <PlusCircle className="h-4 w-4 text-primary" />
                      <span>Install Saved Addons</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="add-by-tag">
                    <div className="flex items-center gap-2">
                      <Tags className="h-4 w-4 text-blue-500" />
                      <span>Install Addons by Tag</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="install-from-url">
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-indigo-500" />
                      <span>Install from URLs</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="clone-account">
                    <div className="flex items-center gap-2">
                      <Copy className="h-4 w-4 text-purple-500" />
                      <span>Clone from Account</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="update-addons">
                    <div className="flex items-center gap-2">
                      <RefreshCw className="h-4 w-4 text-orange-500" />
                      <span>Update Existing Addons</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="remove-addons">
                    <div className="flex items-center gap-2">
                      <Trash2 className="h-4 w-4 text-destructive" />
                      <span>Remove Specific Addons</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="remove-by-tag">
                    <div className="flex items-center gap-2">
                      <Tags className="h-4 w-4 text-destructive" />
                      <span>Remove Addons by Tag</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="protect-all">
                    <div className="flex items-center gap-2">
                      <Shield className="h-4 w-4 text-green-500" />
                      <span>Protect All Addons</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="unprotect-all">
                    <div className="flex items-center gap-2">
                      <ShieldOff className="h-4 w-4 text-red-500" />
                      <span>Unprotect All Addons</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Dynamic Content Card */}
        <Card className="border shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 uppercase tracking-wide text-muted-foreground">
              {action.includes('tag') ? <Tags className="h-4 w-4" /> :
                action.includes('remove') ? <Trash2 className="h-4 w-4" /> :
                  action.includes('update') ? <RefreshCw className="h-4 w-4" /> :
                    action === 'install-from-url' ? <Globe className="h-4 w-4" /> :
                      action === 'clone-account' ? <Copy className="h-4 w-4" /> :
                        action === 'protect-all' ? <Shield className="h-4 w-4" /> :
                          action === 'unprotect-all' ? <ShieldOff className="h-4 w-4" /> :
                            <PlusCircle className="h-4 w-4" />}
              Configuration
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Add Saved Addons */}
            {action === 'add-saved-addons' && (
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <Label>Select Saved Addons</Label>
                  <span className="text-xs text-muted-foreground">{selectedSavedAddonIds.size} selected</span>
                </div>
                <div className="border rounded-md max-h-60 overflow-y-auto bg-background">
                  {savedAddons.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-8 text-center italic">
                      No saved addons in your library.
                    </p>
                  ) : (
                    <div className="divide-y">
                      {savedAddons.map((savedAddon) => (
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
                              {savedAddon.tags.slice(0, 3).map(tag => (
                                <span key={tag} className="text-[10px] px-1.5 py-0.5 bg-muted rounded-full text-muted-foreground">{tag}</span>
                              ))}
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

            {/* Add by Tag */}
            {action === 'add-by-tag' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Select Tag to Install</Label>
                  <Select value={selectedTag} onValueChange={setSelectedTag}>
                    <SelectTrigger className="bg-background">
                      <SelectValue placeholder="Choose a tag..." />
                    </SelectTrigger>
                    <SelectContent>
                      {allTags.map((tag) => {
                        const count = savedAddons.filter((addon) => addon.tags.includes(tag)).length
                        return (
                          <SelectItem key={tag} value={tag}>
                            {tag} <span className="text-muted-foreground ml-1">({count} addons)</span>
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                  {isInvalidTag && (
                    <p className="text-xs text-destructive mt-1 font-medium flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> {/* Placeholder icon */}
                      No saved addons found with this tag.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* NEW: Install from URL */}
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

            {/* NEW: Clone Account */}
            {action === 'clone-account' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Source Account</Label>
                  <p className="text-xs text-muted-foreground">
                    Select an account to copy addons FROM. These addons will be <b>added</b> to the selected target accounts (existing addons on targets will be preserved).
                  </p>
                  <Select value={sourceAccountId} onValueChange={setSourceAccountId}>
                    <SelectTrigger className="bg-background">
                      <SelectValue placeholder="Select source account..." />
                    </SelectTrigger>
                    <SelectContent>
                      {allAccounts.map(acc => (
                        <SelectItem key={acc.id} value={acc.id}>
                          {acc.name !== acc.email ? acc.name : acc.email}
                        </SelectItem>
                      ))}
                      {allAccounts.length === 0 && <SelectItem value="none" disabled>No accounts available</SelectItem>}
                    </SelectContent>
                  </Select>

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

                  {selectedAccounts.some(s => s.id === sourceAccountId) && (
                    <p className="text-xs text-amber-600 font-medium">
                      Warning: Source account is also in the target list. It will be skipped.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Remove Addons */}
            {action === 'remove-addons' && (
              <div className="space-y-3">
                <div className="flex justify-between items-center">
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
                  <span className="text-xs text-muted-foreground">{selectedAddonIds.size} selected</span>
                </div>
                <div className="border rounded-md max-h-60 overflow-y-auto bg-background">
                  {allAddons.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-8 text-center italic">No installed addons found on selected accounts.</p>
                  ) : (
                    <div className="divide-y">
                      {allAddons.map((addon) => (
                        <label
                          key={addon.manifest.id}
                          className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            className="rounded border-gray-300 text-destructive focus:ring-destructive"
                            checked={selectedAddonIds.has(addon.manifest.id)}
                            onChange={() => toggleAddon(addon.manifest.id)}
                          />
                          {(addon.manifest.logo) ? (
                            <img
                              src={addon.manifest.logo}
                              alt={addon.manifest.name}
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
                              <p className="text-sm font-medium truncate">{addon.manifest.name}</p>
                              {(addon.flags?.protected || addon.flags?.official) && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${addon.flags?.protected
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                  : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                  }`}>
                                  {addon.flags?.protected ? 'Protected' : 'Official'}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{addon.manifest.id}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Remove by Tag */}
            {action === 'remove-by-tag' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Select Tag to Remove</Label>
                  <Select value={selectedTag} onValueChange={setSelectedTag}>
                    <SelectTrigger className="bg-background">
                      <SelectValue placeholder="Choose a tag..." />
                    </SelectTrigger>
                    <SelectContent>
                      {allTags.map((tag) => {
                        const count = savedAddons.filter((addon) => addon.tags.includes(tag)).length
                        return (
                          <SelectItem key={tag} value={tag}>
                            {tag} <span className="text-muted-foreground ml-1">({count} known addons)</span>
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Update Addons */}
            {action === 'update-addons' && (
              <div className="space-y-3">
                <div className="flex justify-between items-center">
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
                  <span className="text-xs text-muted-foreground">{selectedUpdateAddonIds.size} selected</span>
                </div>
                <p className="text-xs text-muted-foreground mb-2">
                  Re-installs selected addons from their source URL to get the latest version.
                </p>
                <div className="border rounded-md max-h-60 overflow-y-auto bg-background">
                  {allAddons.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-8 text-center italic">No addons available.</p>
                  ) : (
                    <div className="divide-y">
                      {allAddons.map((addon) => (
                        <label
                          key={addon.manifest.id}
                          className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            className="rounded border-gray-300 text-primary focus:ring-primary"
                            checked={selectedUpdateAddonIds.has(addon.manifest.id)}
                            onChange={() => {
                              setSelectedUpdateAddonIds((prev) => {
                                const newSet = new Set(prev)
                                if (newSet.has(addon.manifest.id)) {
                                  newSet.delete(addon.manifest.id)
                                } else {
                                  newSet.add(addon.manifest.id)
                                }
                                return newSet
                              })
                            }}
                          />
                          {(addon.manifest.logo) ? (
                            <img
                              src={addon.manifest.logo}
                              alt={addon.manifest.name}
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
                              <p className="text-sm font-medium truncate">{addon.manifest.name}</p>
                              {addon.flags?.protected && (
                                <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 rounded-full">
                                  Protected
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">v{addon.manifest.version}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Protect / Unprotect All */}
            {(action === 'protect-all' || action === 'unprotect-all') && (
              <div className="space-y-4">
                <div className="p-4 rounded-lg bg-muted/30 border border-dashed text-center">
                  <p className="text-sm font-medium">
                    This will {action === 'protect-all' ? 'enable' : 'disable'} protection for ALL addons on the {selectedAccounts.length} selected accounts.
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Protected addons cannot be removed or modified unless protection is disabled.
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
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
        >
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {success ? 'Done' : 'Execute'}
        </Button>
      </div>
    </div>
  )
}
