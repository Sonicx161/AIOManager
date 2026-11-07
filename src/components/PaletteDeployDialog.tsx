import { useEffect, useRef } from 'react'
import { AccountPickerDialog } from '@/components/accounts/AccountPickerDialog'
import { DeploymentPreview } from '@/components/saved-addons/DeploymentPreview'
import { useSavedAddonSelectionActions } from '@/components/saved-addons/hooks/useSavedAddonSelectionActions'
import { useAddonStore } from '@/store/addonStore'
import type { SavedAddon } from '@/types/saved-addon'

interface PaletteDeployDialogProps {
  addonId: string
  onClose: () => void
}

const NO_ADDONS: SavedAddon[] = []

export function PaletteDeployDialog({ addonId, onClose }: PaletteDeployDialogProps) {
  const library = useAddonStore((s) => s.library)
  const { selectedIds, setSelectedIds, showAccountPicker, setShowAccountPicker, handleDeployToAccounts } =
    useSavedAddonSelectionActions({ filteredAddons: NO_ADDONS, library })
  const opened = useRef(false)

  useEffect(() => {
    setSelectedIds(new Set([addonId]))
    setShowAccountPicker(true)
  }, [addonId, setSelectedIds, setShowAccountPicker])

  useEffect(() => {
    if (showAccountPicker) opened.current = true
    else if (opened.current) onClose()
  }, [showAccountPicker, onClose])

  return (
    <AccountPickerDialog
      open={showAccountPicker}
      onOpenChange={setShowAccountPicker}
      title={`Deploy ${library[addonId]?.name ?? 'Addon'}`}
      description="Select the accounts where you want to install this addon."
      onConfirm={handleDeployToAccounts}
      confirmLabel="Deploy"
      renderPreview={(accountIds) => (
        <DeploymentPreview selectedAddonIds={selectedIds} library={library} accountIds={accountIds} />
      )}
    />
  )
}
