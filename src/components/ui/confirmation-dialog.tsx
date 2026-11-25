import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog"
import { Button } from "./button"
import { cn } from "@/lib/utils"

interface ConfirmationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: React.ReactNode
  confirmText?: string
  cancelText?: string
  isDestructive?: boolean
  isLoading?: boolean
  disabled?: boolean
  severity?: "warning" | "danger" | "info"
  impactItems?: React.ReactNode[]
  details?: React.ReactNode
  onConfirm: () => void
}

export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  isDestructive = false,
  isLoading = false,
  disabled = false,
  impactItems,
  details,
  onConfirm,
}: ConfirmationDialogProps) {
  const handleConfirm = () => {
    onConfirm()
  }

  const confirmVariant = isDestructive ? "destructive" : "default"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideClose className={cn("max-w-md gap-0 overflow-hidden p-0", details && "flex flex-col")}>
        <DialogHeader className={cn("items-center px-6 pb-5 pt-7 text-center", details && "min-h-0 overflow-y-auto")}>
          <DialogTitle className="text-xl tracking-tight">{title}</DialogTitle>
          <DialogDescription className="max-w-sm space-y-2 text-pretty text-sm leading-6">
            {description}
          </DialogDescription>
          {impactItems && impactItems.length > 0 && (
            <div data-theme-part="panel" className="mt-4 w-full rounded-2xl border border-border/40 bg-muted/25 p-3 text-left">
              <div className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Impact</div>
              <div className="space-y-1.5">
                {impactItems.map((item, index) => (
                  <div key={index} className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-45" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {details}
        </DialogHeader>
        <DialogFooter className={cn("grid grid-cols-2 gap-3 px-4 pb-4 pt-0 sm:grid-cols-2", details && "shrink-0")}>
          <Button
            variant="subtle"
            onClick={() => onOpenChange(false)}
            disabled={isLoading || disabled}
            className="h-11 rounded-full"
            ripple={false}
          >
            {cancelText}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={handleConfirm}
            disabled={isLoading || disabled}
            className="h-11 rounded-full"
            ripple={false}
          >
            {isLoading ? "Processing..." : confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
