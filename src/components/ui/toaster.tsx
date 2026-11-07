import { cn } from '@/lib/utils'
import { DEFAULT_TOAST_DURATION, useToast, type Toast } from '@/hooks/use-toast'
import { AlertCircle, AlertTriangle, CheckCircle, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'

function ToastAction({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  const action = toast.action
  const duration = toast.duration ?? DEFAULT_TOAST_DURATION
  const finite = Number.isFinite(duration) && duration > 0
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!finite) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [finite, toast.createdAt])

  if (!action) return null
  const seconds = finite ? Math.max(0, Math.ceil((toast.createdAt + duration - now) / 1000)) : null

  return (
    <button
      type="button"
      onClick={() => { action.onClick(); onDone() }}
      className="shrink-0 rounded-lg border border-border/50 bg-muted/50 px-2.5 py-1.5 text-xs font-bold tabular-nums text-foreground transition-colors hover:bg-muted"
    >
      {action.label}
      {seconds !== null && <span className="ml-1 font-medium text-muted-foreground">({seconds}s)</span>}
    </button>
  )
}

export function Toaster() {
  const { toasts, dismiss } = useToast()

  return (
    <div aria-live="polite" aria-atomic="true" className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 px-3 pt-[calc(env(safe-area-inset-top,0px)+12px)] sm:left-auto sm:right-4 sm:w-full sm:max-w-sm sm:items-stretch">
      <AnimatePresence initial={false} mode="sync">
        {toasts.map((toast) => {
          const isDestructive = toast.variant === 'destructive'
          const isWarning = toast.variant === 'warning'
          const Icon = isDestructive ? AlertCircle : isWarning ? AlertTriangle : CheckCircle

          return (
            <motion.div
              key={toast.id}
              data-theme-part="toast"
              data-variant={toast.variant ?? 'default'}
              layout
              initial={{ opacity: 0, y: -16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.96 }}
              transition={{ duration: 0.24, ease: 'easeOut' }}
              className={cn(
                "pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-[1.35rem] border border-border/45 bg-card/95 text-card-foreground shadow-[0_10px_30px_rgba(0,0,0,0.12)] ring-1 ring-black/[0.03] backdrop-blur-md",
                toast.className
              )}
            >
              <div className="flex items-center gap-3 px-4 py-3.5">
                <div data-theme-part="badge" className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border shadow-sm",
                  isDestructive
                    ? "border-destructive/20 bg-destructive/10 text-destructive"
                    : isWarning
                      ? "border-warning/20 bg-warning/10 text-warning"
                      : "border-border/40 bg-muted/45 text-foreground"
                )}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  {isWarning && (
                    <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">
                      Time Sensitive
                    </p>
                  )}
                  <p className={cn(
                    "line-clamp-2 text-sm font-semibold leading-snug [overflow-wrap:anywhere]",
                    isDestructive && "text-destructive"
                  )}>
                    {toast.title}
                  </p>
                  {toast.description && (
                    <p className="mt-0.5 line-clamp-3 text-sm leading-snug text-muted-foreground [overflow-wrap:anywhere]">
                      {toast.description}
                    </p>
                  )}
                </div>
                {toast.action && <ToastAction toast={toast} onDone={() => dismiss(toast.id)} />}
                <button
                  data-theme-part="button"
                  data-variant="ghost"
                  onClick={() => dismiss(toast.id)}
                  className="shrink-0 rounded-full p-1 text-muted-foreground/60 transition-colors hover:bg-muted/70 hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                  <span className="sr-only">Close</span>
                </button>
              </div>
              {toast.action && Number.isFinite(toast.duration ?? DEFAULT_TOAST_DURATION) && (
                <motion.div
                  key={toast.createdAt}
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-primary/60"
                  initial={{ scaleX: 1 }}
                  animate={{ scaleX: 0 }}
                  transition={{ duration: (toast.duration ?? DEFAULT_TOAST_DURATION) / 1000, ease: 'linear' }}
                />
              )}
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
