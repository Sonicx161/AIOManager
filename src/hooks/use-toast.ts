import { useCallback, useState } from 'react'

export interface Toast {
  id: string
  title: string
  description?: React.ReactNode
  variant?: 'default' | 'destructive'
  className?: string
}

// Simple toast state management - in a real app you'd use a more robust solution
let toastListeners: ((toasts: Toast[]) => void)[] = []
let toasts: Toast[] = []

const notifyListeners = () => {
  toastListeners.forEach((listener) => listener([...toasts]))
}

// Standalone toast function that can be used outside of React components
export function toast({ title, description, variant = 'default', className }: Omit<Toast, 'id'>) {
  const id = crypto.randomUUID()
  const newToast: Toast = { id, title, description, variant, className }

  toasts = [...toasts, newToast]
  notifyListeners()

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id)
    notifyListeners()
  }, 5000)

  return id
}

export function useToast() {
  const [, setLocalToasts] = useState<Toast[]>([])

  // Subscribe to global toast state
  useState(() => {
    const listener = (newToasts: Toast[]) => setLocalToasts(newToasts)
    toastListeners.push(listener)
    return () => {
      toastListeners = toastListeners.filter((l) => l !== listener)
    }
  })

  const dismiss = useCallback((toastId: string) => {
    toasts = toasts.filter((t) => t.id !== toastId)
    notifyListeners()
  }, [])

  return {
    toast,
    dismiss,
    toasts,
  }
}
