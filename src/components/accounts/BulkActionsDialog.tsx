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
import { useProfileStore } from '@/store/profileStore'
import { StremioAccount } from '@/types/account'
import { BulkResult } from '@/types/saved-addon'
import { Copy, Globe, LayoutGrid, Library, Loader2, PlusCircle, RefreshCw, Tags, Trash2, AlertTriangle, Shield, ShieldOff } from 'lucide-react'
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
  | 'install-from-library'
  | 'add-saved-addons'
  | 'install-from-url'
  | 'clone-account'
  | 'update-addons'
  | 'reinstall-all'
  | 'protect-all'
  | 'unprotect-all'
  | 'remove-addons'

export function BulkActionsDialog({ selectedAccounts, allAccounts = [], onClose }: BulkActionsDialogProps) {
  const {
    library,
    getAllTags,
    bulkApplySavedAddons,
    bulkRemoveAddons,
    bulkReinstallAddons,
    bulkInstallFromUrls,
    bulkCloneAccount,
    loading,
  } = useAddonStore()
  const { bulkProtectAddons } = useAccountStore()
  const { profiles } = useProfileStore()

  const [action, setAction] = useState<BulkAction>('install-from-library')
  const [selectedSavedAddonIds, setSelectedSavedAddonIds] = useState<Set<string>>(new Set())
  const [selectedAddonIds, setSelectedAddonIds] = useState<Set<string>>(new Set())
  const [selectedUpdateAddonIds, setSelectedUpdateAddonIds] = useState<Set<string>>(new Set())

  // New State
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

  const savedAddons = Object.values(library).sort((a, b) => a.name.localeCompare(b.name))
  const allTags = getAllTags()

  const currentTagAddonsCount = selectedInstallTagName
    ? savedAddons.filter((addon) => addon.tags.includes(selectedInstallTagName)).length
    : 0

  const isTagAction = action === 'install-from-library' && installMode === 'tag'
  const isInvalidTag = isTagAction && selectedInstallTagName !== '' && currentTagAddonsCount === 0

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

          bulkResult = await bulkApplySavedAddons(
            Array.from(selectedSavedAddonIds),
            accountsData,
            true // allowProtected override
          )
          break

        case 'remove-addons':
          if (selectedAddonIds.size === 0) {
            setError('Please select at least one addon to remove')
            return
          }
          bulkResult = await bulkRemoveAddons(Array.from(selectedAddonIds), accountsData, true)
          break

          bulkResult = await bulkRemoveAddons(Array.from(selectedAddonIds), accountsData, true)
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
                  <SelectValue placeholder="What should we do?" />
                </SelectTrigger>
                <SelectContent>
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
                        <p className="font-medium">Pick Saved Addons</p>
                        <p className="text-[10px] text-muted-foreground">Select individual addons from library</p>
                      </div>
                    </div>
                  </SelectItem>

                  <SelectItem value="install-from-url" className="focus:bg-primary/10">
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-blue-500" />
                      <div className="text-left">
                        <p className="font-medium">Install from URLs</p>
                        <p className="text-[10px] text-muted-foreground">Batch install manifest links</p>
                      </div>
                    </div>
                  </SelectItem>

                  <SelectItem value="clone-account" className="focus:bg-primary/10">
                    <div className="flex items-center gap-2">
                      <Copy className="h-4 w-4 text-amber-500" />
                      <div className="text-left">
                        <p className="font-medium">Clone Account Addons</p>
                        <p className="text-[10px] text-muted-foreground">Copy all addons from one to many</p>
                      </div>
                    </div>
                  </SelectItem>

                  <div className="h-px bg-muted my-1" />

                  <SelectItem value="update-addons" className="focus:bg-primary/10 text-primary font-semibold">
                    <div className="flex items-center gap-2">
                      <RefreshCw className="h-4 w-4" />
                      <p>Force Update All</p>
                    </div>
                  </SelectItem>

                  <SelectItem value="reinstall-all" className="focus:bg-primary/10 text-primary font-semibold">
                    <div className="flex items-center gap-2">
                      <RefreshCw className="h-4 w-4" />
                      <p>Clean Reinstall All</p>
                    </div>
                  </SelectItem>

                  <div className="h-px bg-muted my-1" />

                  <SelectItem value="protect-all" className="focus:bg-primary/10">
                    <div className="flex items-center gap-2">
                      <Shield className="h-4 w-4 text-emerald-500" />
                      <p>Enable Protection All</p>
                    </div>
                  </SelectItem>

                  <SelectItem value="unprotect-all" className="focus:bg-primary/10">
                    <div className="flex items-center gap-2">
                      <ShieldOff className="h-4 w-4 text-amber-500" />
                      <p>Disable Protection All</p>
                    </div>
                  </SelectItem>

                  <div className="h-px bg-muted my-1" />

                  <SelectItem value="remove-addons" className="focus:bg-destructive/10 text-destructive font-semibold">
                    <div className="flex items-center gap-2">
                      <Trash2 className="h-4 w-4" />
                      <p>Remove Selected Addons</p>
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
                            action === 'install-from-library' ? <Library className="h-4 w-4 text-primary" /> :
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

            {/* Clone Account */}
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

            {/* Remove by Tag handled via unified Library UI or pick manually */}

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
    </div>
  )
}
