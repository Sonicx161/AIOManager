import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import type { SavedAddon } from '@/types/saved-addon'
import type { Account } from '@/types/account'
import { SavedAddonDetails } from './SavedAddonDetails'

interface SavedAddonEditDialogProps {
    savedAddon: SavedAddon
    deployedAccounts?: Account[]
    open: boolean
    onOpenChange: (open: boolean) => void
}

// Shared editor for the card and the list row: same title, width, and per-account sync picker.
export function SavedAddonEditDialog({ savedAddon, deployedAccounts = [], open, onOpenChange }: SavedAddonEditDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
                <DialogHeader>
                    <DialogTitle>Edit Saved Addon</DialogTitle>
                    <DialogDescription>
                        Customize how this saved addon appears and where it lives in your library.
                    </DialogDescription>
                </DialogHeader>
                <SavedAddonDetails savedAddon={savedAddon} deployedAccounts={deployedAccounts} onClose={() => onOpenChange(false)} />
            </DialogContent>
        </Dialog>
    )
}

interface SavedAddonDeleteConfirmProps {
    savedAddon: SavedAddon
    open: boolean
    onOpenChange: (open: boolean) => void
    onConfirm: () => void
}

export function SavedAddonDeleteConfirm({ savedAddon, open, onOpenChange, onConfirm }: SavedAddonDeleteConfirmProps) {
    return (
        <ConfirmationDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Delete Saved Addon?"
            description={
                <>
                    <p>Are you sure you want to delete "{savedAddon.name}"?</p>
                    <p className="font-semibold">
                        This will NOT remove it from accounts where it's already installed.
                    </p>
                </>
            }
            confirmText="Delete"
            isDestructive={true}
            onConfirm={onConfirm}
        />
    )
}
