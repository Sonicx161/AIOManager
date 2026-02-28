import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'
import { AlertCircle, CheckCircle, X } from 'lucide-react'
import { Button } from './button'

export function Toaster() {
  const { toasts, dismiss } = useToast()

  return (
    <div className="fixed bottom-0 right-0 z-50 flex flex-col gap-2 p-4 pb-[calc(76px+env(safe-area-inset-bottom,16px)+8px)] md:pb-4 w-full sm:max-w-md pointer-events-none">
      {toasts.map((toast) => {
        const isDestructive = toast.variant === 'destructive'
        const Icon = isDestructive ? AlertCircle : CheckCircle

        return (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto relative overflow-hidden rounded-lg border shadow-lg animate-in slide-in-from-bottom-5 fade-in",
              isDestructive
                ? "bg-destructive text-destructive-foreground border-destructive"
                : "bg-background border-border",
              toast.className
            )}
          >
            <div className="flex items-start gap-3 p-4">
              <Icon
                className={`h-5 w-5 flex-shrink-0 mt-0.5 ${isDestructive ? 'text-destructive-foreground' : 'text-green-500'
                  }`}
              />
              <div className="flex-1 min-w-0">
                <p
                  className="text-sm font-medium"
                >
                  {toast.title}
                </p>
                {toast.description && (
                  <p
                    className={`text-sm mt-1 ${isDestructive ? 'text-destructive-foreground/90' : 'text-muted-foreground'
                      }`}
                  >
                    {toast.description}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className={`h-6 w-6 p-0 opacity-70 hover:opacity-100 ${isDestructive ? 'text-destructive-foreground hover:text-destructive-foreground' : ''}`}
                onClick={() => dismiss(toast.id)}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
