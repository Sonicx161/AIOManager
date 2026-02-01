import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useUIStore } from '@/store/uiStore'
import { useAccountStore } from '@/store/accountStore'
import { toast } from '@/hooks/use-toast'

export function ImportDialog() {
  const isOpen = useUIStore((state) => state.isImportDialogOpen)
  const closeDialog = useUIStore((state) => state.closeImportDialog)
  const importAccounts = useAccountStore((state) => state.importAccounts)
  const loading = useAccountStore((state) => state.loading)

  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')

  const handleClose = () => {
    setFile(null)
    setError('')
    closeDialog()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) {
      if (selectedFile.type !== 'application/json') {
        setError('Please select a valid JSON file')
        setFile(null)
        return
      }
      setFile(selectedFile)
      setError('')
    }
  }

  const handleImport = async () => {
    if (!file) {
      setError('Please select a file')
      return
    }

    try {
      const text = await file.text()
      await importAccounts(text)

      // Attempt to sync immediately to ensure addons are populated in the UI
      try {
        await useAccountStore.getState().syncAllAccounts()
      } catch (e) {
        console.error("Sync on import failed", e)
      }

      handleClose()

      toast({
        title: "Import Complete",
        description: "Your accounts and addons are ready.",
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import accounts')
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import Accounts</DialogTitle>
          <DialogDescription>
            Import accounts from a previously exported JSON file
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="file">Select JSON file</Label>
            <input
              type="file"
              id="file"
              accept=".json,application/json"
              onChange={handleFileChange}
              className="block w-full text-sm text-muted-foreground
                file:mr-4 file:py-2 file:px-4
                file:rounded-md file:border-0
                file:text-sm file:font-medium
                file:bg-primary file:text-primary-foreground
                hover:file:bg-primary/90
                cursor-pointer"
            />
          </div>

          {file && (
            <div className="text-sm text-muted-foreground">
              Selected: {file.name} ({(file.size / 1024).toFixed(2)} KB)
            </div>
          )}

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}

          <div className="bg-muted px-4 py-3 rounded-md text-sm">
            <strong>Note:</strong> Imported accounts will be added to your existing accounts.
            Duplicates will not be detected.
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={!file || loading}>
            {loading ? 'Importing...' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
