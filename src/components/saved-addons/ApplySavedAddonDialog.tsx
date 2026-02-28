import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useAccounts } from '@/hooks/useAccounts'
import { useAddonStore } from '@/store/addonStore'
import { useUIStore } from '@/store/uiStore'
import { BulkResult, SavedAddon } from '@/types/saved-addon'
import { useState } from 'react'
import { maskEmail } from '@/lib/utils'

interface ApplySavedAddonDialogProps {
  savedAddon: SavedAddon
  onClose: () => void
}

export function ApplySavedAddonDialog({ savedAddon, onClose }: ApplySavedAddonDialogProps) {
  const { applySavedAddonToAccounts, loading } = useAddonStore()
  const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)
  const { accounts } = useAccounts()

  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [result, setResult] = useState<BulkResult | null>(null)

  const toggleAccount = (accountId: string) => {
    setSelectedAccountIds((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(accountId)) {
        newSet.delete(accountId)
      } else {
        newSet.add(accountId)
      }
      return newSet
    })
  }

  const selectAll = () => {
    setSelectedAccountIds(new Set(accounts.map((a) => a.id)))
  }

  const selectNone = () => {
    setSelectedAccountIds(new Set())
  }

  const handleApply = async () => {
    if (selectedAccountIds.size === 0) {
      setError('Please select at least one account')
      return
    }

    setError(null)
    setSuccess(false)

    try {
      const accountsToApply = accounts
        .filter((a) => selectedAccountIds.has(a.id))
        .map((a) => ({ id: a.id, authKey: a.authKey }))

      const bulkResult = await applySavedAddonToAccounts(savedAddon.id, accountsToApply)

      setResult(bulkResult)
      setSuccess(true)

      if (bulkResult.failed === 0) {
        setTimeout(() => {
          onClose()
        }, 2000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply saved addon')
    }
  }

  return (
    <div className="space-y-4">
      {/* Success Message */}
      {success && result && (
        <div className="p-3 rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
          <p className="text-sm text-green-600 dark:text-green-400 font-medium">
            Applied saved addon to {result.success} account{result.success !== 1 ? 's' : ''}
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

      {/* Saved Addon Info */}
      <div className="p-3 rounded-md bg-gray-50 dark:bg-gray-900">
        <p className="font-medium">{savedAddon.name}</p>
        <p className="text-sm text-muted-foreground">{savedAddon.manifest.name}</p>
      </div>

      {/* Account Selection */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Select Accounts ({selectedAccountIds.size} selected)</Label>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={selectAll}>
              Select All
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={selectNone}>
              Clear
            </Button>
          </div>
        </div>

        <div className="border rounded-md max-h-64 overflow-y-auto">
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4 text-center">No accounts available</p>
          ) : (
            <div className="divide-y">
              {accounts.map((account) => (
                <label
                  key={account.id}
                  className="flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedAccountIds.has(account.id)}
                    onChange={() => toggleAccount(account.id)}
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium flex items-center gap-1.5">
                      {account.emoji && <span className="text-base shrink-0">{account.emoji}</span>}
                      {(() => {
                        const isNameCustomized =
                          account.name !== account.email && account.name !== 'Stremio Account'
                        return isPrivacyModeEnabled && !isNameCustomized
                          ? account.name.includes('@')
                            ? maskEmail(account.name)
                            : '********'
                          : account.name
                      })()}
                    </p>
                    {account.email && (
                      <p className="text-xs text-muted-foreground">
                        {isPrivacyModeEnabled ? maskEmail(account.email) : account.email}
                      </p>
                    )}
                  </div>

                  <span className="text-xs text-muted-foreground">
                    {account.addons.length} addons
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-4">
        <Button
          onClick={handleApply}
          disabled={loading || selectedAccountIds.size === 0 || success}
          className="flex-1"
        >
          {loading
            ? 'Applying...'
            : success
              ? 'Applied!'
              : `Apply to ${selectedAccountIds.size} Account${selectedAccountIds.size !== 1 ? 's' : ''}`}
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          {success ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </div>
  )
}
