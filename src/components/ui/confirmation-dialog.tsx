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
import { AlertTriangle, Info, ShieldAlert } from "lucide-react"
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
  severity,
  impactItems,
  details,
  onConfirm,
}: ConfirmationDialogProps) {
  const handleConfirm = () => {
    onConfirm()
  }

  const confirmVariant = isDestructive ? "destructive" : "default"
  const resolvedSeverity = severity || (isDestructive ? "danger" : undefined)
  const severityConfig = {
    danger: {
      icon: ShieldAlert,
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    },
    warning: {
      icon: AlertTriangle,
      className: "border-warning/30 bg-warning/10 text-warning",
    },
    info: {
      icon: Info,
      className: "border-info/30 bg-info/10 text-info",
    },
  } as const
  const Icon = resolvedSeverity ? severityConfig[resolvedSeverity].icon : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideClose className={cn("max-w-md gap-0 overflow-hidden p-0", details && "flex flex-col")}>
        <DialogHeader className={cn("items-center px-6 pb-5 pt-7 text-center", details && "min-h-0 overflow-y-auto")}>
          {Icon && resolvedSeverity && (
            <div data-theme-part="badge" className={cn(
              "mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border shadow-[inset_0_0.5px_0_hsl(0_0%_100%/0.08)]",
              severityConfig[resolvedSeverity].className
            )}>
              <Icon className="h-6 w-6" />
            </div>
          )}
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
