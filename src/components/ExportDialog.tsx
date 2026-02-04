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

export function ExportDialog() {
  const isOpen = useUIStore((state) => state.isExportDialogOpen)
  const closeDialog = useUIStore((state) => state.closeExportDialog)
  const exportAccounts = useAccountStore((state) => state.exportAccounts)

  const [includeCredentials, setIncludeCredentials] = useState(true)
  const [isExporting, setIsExporting] = useState(false)

  const handleClose = () => {
    setIncludeCredentials(true)
    closeDialog()
  }

  const handleExport = async () => {
    setIsExporting(true)
    try {
      const json = await exportAccounts(includeCredentials)

      const blob = new Blob([json], {
        type: 'application/json',
      })

      const url = URL.createObjectURL(blob)
      const now = new Date()
      const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`

      const a = document.createElement('a')
      a.href = url
      a.download = `AIOManager-Backup-${timestamp}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      handleClose()
    } catch (error) {
      console.error('Export failed:', error)
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export Accounts</DialogTitle>
          <DialogDescription>
            Export your accounts and saved addon library to a JSON file for backup or transfer
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-start space-x-3">
            <input
              type="checkbox"
              id="includeCredentials"
              checked={includeCredentials}
              onChange={(e) => setIncludeCredentials(e.target.checked)}
              className="mt-1"
            />
            <div className="flex-1">
              <Label htmlFor="includeCredentials" className="cursor-pointer">
                Include credentials (auth keys and passwords)
              </Label>
              <p className="text-xs text-muted-foreground mt-1">
                Credentials are included by default for easy re-import. Uncheck this if you only
                want to export addon configurations.
              </p>
            </div>
          </div>

          {includeCredentials && (
            <div className="bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded-md text-sm">
              <strong>Security Warning:</strong> The exported file will contain your Stremio
              credentials in plain text. Keep this file secure and delete it after use.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleClose} disabled={isExporting}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={isExporting}>
            {isExporting ? 'Exporting...' : 'Export'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
