import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAddonStore } from '@/store/addonStore'
import { StremioAccount } from '@/types/account'
import { BulkResult } from '@/types/saved-addon'
import { useState } from 'react'

interface BulkActionsDialogProps {
  selectedAccounts: StremioAccount[]
  onClose: () => void
}

type BulkAction =
  | 'add-saved-addons'
  | 'add-by-tag'
  | 'remove-addons'
  | 'remove-by-tag'
  | 'update-addons'

export function BulkActionsDialog({ selectedAccounts, onClose }: BulkActionsDialogProps) {
  const {
    library,
    getAllTags,
    bulkApplySavedAddons,
    bulkApplyTag,
    bulkRemoveAddons,
    bulkRemoveByTag,
    bulkReinstallAddons,
    loading,
  } = useAddonStore()

  const [action, setAction] = useState<BulkAction>('add-saved-addons')
  const [selectedSavedAddonIds, setSelectedSavedAddonIds] = useState<Set<string>>(new Set())
  const [selectedTag, setSelectedTag] = useState<string>('')
  const [selectedAddonIds, setSelectedAddonIds] = useState<Set<string>>(new Set())
  const [selectedUpdateAddonIds, setSelectedUpdateAddonIds] = useState<Set<string>>(new Set())
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

  // Collect all unique addons across selected accounts, excluding protected ones, and sort alphabetically
  const allAddons = Array.from(
    new Map(
      selectedAccounts.flatMap((acc) =>
        acc.addons
          .filter((addon) => !addon.flags?.protected)
          .map((addon) => [addon.manifest.id, addon])
      )
    ).values()
  ).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))

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
            accountsData
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
          bulkResult = await bulkRemoveAddons(Array.from(selectedAddonIds), accountsData)
          break

        case 'remove-by-tag':
          if (!selectedTag) {
            setError('Please select a tag')
            return
          }
          bulkResult = await bulkRemoveByTag(selectedTag, accountsData)
          break

        case 'update-addons':
          if (selectedUpdateAddonIds.size === 0) {
            setError('Please select at least one addon to update')
            return
          }
          bulkResult = await bulkReinstallAddons(Array.from(selectedUpdateAddonIds), accountsData)
          break
      }

      setResult(bulkResult)
      setSuccess(true)

      if (bulkResult.failed === 0) {
        setTimeout(() => {
          onClose()
        }, 2000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed')
    }
  }

  return (
    <div className="space-y-4">
      {/* Success Message */}
      {success && result && (
        <div className="p-3 rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
          <p className="text-sm text-green-600 dark:text-green-400 font-medium">
            Operation completed on {result.success} account
            {result.success !== 1 ? 's' : ''}
            {result.failed > 0 && ` (${result.failed} failed)`}
          </p>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="p-3 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Selected Accounts */}
      <div className="p-3 rounded-md bg-muted/50 border">
        <p className="text-sm font-medium text-foreground">
          {selectedAccounts.length} account{selectedAccounts.length !== 1 ? 's' : ''} selected
        </p>
      </div>

      {/* Action Selection */}
      <div className="space-y-2">
        <Label>Action</Label>
        <Select value={action} onValueChange={(v) => setAction(v as BulkAction)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="add-saved-addons">Add Saved Addon(s)</SelectItem>
            <SelectItem value="add-by-tag">Add Addons by Tag</SelectItem>
            <SelectItem value="remove-addons">Remove Addon(s)</SelectItem>
            <SelectItem value="remove-by-tag">Remove Addons by Tag</SelectItem>
            <SelectItem value="update-addons">Update Addon(s)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Add Saved Addons */}
      {action === 'add-saved-addons' && (
        <>
          <div className="space-y-2">
            <Label>Select Saved Addons ({selectedSavedAddonIds.size} selected)</Label>
            <div className="border rounded-md max-h-64 overflow-y-auto">
              {savedAddons.length === 0 ? (
                <p className="text-sm text-muted-foreground p-4 text-center">
                  No saved addons available
                </p>
              ) : (
                <div className="divide-y">
                  {savedAddons.map((savedAddon) => (
                    <label
                      key={savedAddon.id}
                      className="flex items-center gap-3 p-3 hover:bg-accent/50 dark:hover:bg-accent/30 cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selectedSavedAddonIds.has(savedAddon.id)}
                        onChange={() => toggleSavedAddon(savedAddon.id)}
                      />
                      <div className="flex-1">
                        <p className="text-sm font-medium">{savedAddon.name}</p>
                        <p className="text-xs text-muted-foreground">{savedAddon.manifest.name}</p>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Add by Tag */}
      {action === 'add-by-tag' && (
        <>
          <div className="space-y-2">
            <Label>Select Tag</Label>
            <Select value={selectedTag} onValueChange={setSelectedTag}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a tag..." />
              </SelectTrigger>
              <SelectContent>
                {allTags.map((tag) => {
                  const count = savedAddons.filter((addon) => addon.tags.includes(tag)).length
                  return (
                    <SelectItem key={tag} value={tag}>
                      {tag} ({count} saved addons)
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
            {isInvalidTag && (
              <p className="text-xs text-destructive mt-1">
                No saved addons found with this tag. This action will have no effect.
              </p>
            )}
          </div>
        </>
      )}

      {/* Remove Addons */}
      {action === 'remove-addons' && (
        <div className="space-y-2">
          <Label>Select Addons ({selectedAddonIds.size} selected)</Label>
          <div className="border rounded-md max-h-64 overflow-y-auto">
            {allAddons.length === 0 ? (
              <p className="text-sm text-muted-foreground p-4 text-center">No addons available</p>
            ) : (
              <div className="divide-y">
                {allAddons.map((addon) => (
                  <label
                    key={addon.manifest.id}
                    className="flex items-center gap-3 p-3 hover:bg-accent/50 dark:hover:bg-accent/30 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedAddonIds.has(addon.manifest.id)}
                      onChange={() => toggleAddon(addon.manifest.id)}
                      disabled={addon.flags?.protected}
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium">
                        {addon.manifest.name}
                        {(addon.flags?.protected || addon.flags?.official) && (
                          <span className="ml-2 text-xs text-yellow-600">
                            ({addon.flags?.protected ? 'Protected' : 'Official'})
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">{addon.manifest.id}</p>
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
        <div className="space-y-2">
          <Label>Select Tag</Label>
          <Select value={selectedTag} onValueChange={setSelectedTag}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a tag..." />
            </SelectTrigger>
            <SelectContent>
              {allTags.map((tag) => {
                const count = savedAddons.filter((addon) => addon.tags.includes(tag)).length
                return (
                  <SelectItem key={tag} value={tag}>
                    {tag} ({count} saved addons)
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          {isInvalidTag && (
            <p className="text-xs text-destructive mt-1">
              No saved addons found with this tag. This action will have no effect.
            </p>
          )}
        </div>
      )}

      {/* Update Addons */}
      {action === 'update-addons' && (
        <div className="space-y-2">
          <Label>Select Addons to Update ({selectedUpdateAddonIds.size} selected)</Label>
          <p className="text-xs text-muted-foreground">
            Re-install selected addons to get the latest version from their source URL. Addon
            positions will be preserved.
          </p>
          <div className="border rounded-md max-h-64 overflow-y-auto">
            {allAddons.length === 0 ? (
              <p className="text-sm text-muted-foreground p-4 text-center">No addons available</p>
            ) : (
              <div className="divide-y">
                {allAddons.map((addon) => (
                  <label
                    key={addon.manifest.id}
                    className="flex items-center gap-3 p-3 hover:bg-accent/50 dark:hover:bg-accent/30 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
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
                      disabled={addon.flags?.protected}
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium">
                        {addon.manifest.name}
                        {addon.flags?.protected && (
                          <span className="ml-2 text-xs text-yellow-600">(Protected)</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">v{addon.manifest.version}</p>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-4">
        <Button
          onClick={handleExecute}
          disabled={loading || success || isInvalidTag}
          className="flex-1"
        >
          {loading ? 'Processing...' : success ? 'Done!' : 'Execute'}
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          {success ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </div>
  )
}
