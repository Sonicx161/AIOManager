/**
 * Reason + typed confirmation dialog for dashboard actions, on the shared Dialog
 * (Escape handling, focus trap). Destructive actions require a written reason
 * and the exact confirmation word; safe actions can ask for a reason only.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface TypedActionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: React.ReactNode
  /** Confirmation word the operator must type, e.g. DELETE. Null skips typing. */
  confirmWord?: string | null
  requireReason?: boolean
  reasonLabel?: string
  actionLabel: string
  destructive?: boolean
  busy?: boolean
  /** Shown under the form, e.g. what the user sees after the action. */
  footnote?: React.ReactNode
  /** Live reason text, for parents that preview the action while it is typed. */
  onReasonChange?: (reason: string) => void
  onConfirm: (reason: string, confirm: string) => void
}

export function TypedActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmWord = null,
  requireReason = true,
  reasonLabel = 'Reason (required, audited)',
  actionLabel,
  destructive = false,
  busy = false,
  footnote,
  onReasonChange,
  onConfirm,
}: TypedActionDialogProps) {
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const reasonRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setReason('')
      setTyped('')
      // Focus the first field once the dialog has mounted.
      const t = setTimeout(() => reasonRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [open])

  const reasonOk = !requireReason || reason.trim().length > 0
  const typedOk = !confirmWord || typed.trim() === confirmWord
  const ready = useMemo(() => reasonOk && typedOk && !busy, [reasonOk, typedOk, busy])

  const submit = () => {
    if (!ready) return
    onConfirm(reason.trim(), confirmWord ? typed.trim() : '')
  }

  return (
    <Dialog open={open} onOpenChange={open && busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6">
          {requireReason && (
            <div className="space-y-1.5">
              <Label htmlFor="dashboard-action-reason" className="text-xs font-semibold text-muted-foreground">{reasonLabel}</Label>
              <Input
                id="dashboard-action-reason"
                ref={reasonRef}
                value={reason}
                onChange={e => { setReason(e.target.value); onReasonChange?.(e.target.value) }}
                onKeyDown={e => { if (e.key === 'Enter') submit() }}
                maxLength={200}
                autoComplete="off"
              />
            </div>
          )}
          {confirmWord && (
            <div className="space-y-1.5">
              <Label htmlFor="dashboard-action-confirm" className="text-xs font-semibold text-muted-foreground">
                Type <span className="font-mono text-foreground/80">{confirmWord}</span> to confirm
              </Label>
              <Input
                id="dashboard-action-confirm"
                value={typed}
                onChange={e => setTyped(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submit() }}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}
          {footnote && <div className="rounded-xl border border-border/35 bg-muted/20 p-2.5 text-xs leading-relaxed text-muted-foreground">{footnote}</div>}
        </div>
        <DialogFooter className="gap-2 px-6">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={submit} disabled={!ready} data-testid="dashboard-action-confirm-run">
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
