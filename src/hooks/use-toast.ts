import { useCallback, useState, useEffect } from 'react'

export const DEFAULT_TOAST_DURATION = 5000

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  title: string
  description?: React.ReactNode
  variant?: 'default' | 'destructive' | 'warning'
  className?: string
  action?: ToastAction
  /** 'signin' marks this toast as a sign-in fix so the notification inbox can offer that action after the toast is gone. */
  actionHint?: 'signin'
  /** The connection a sign-in fix notice points at. */
  actionTarget?: { connectionId: string; platform: string }
  duration?: number
  href?: string
  accountId?: string
  history?: boolean
  createdAt: number
}

type ToastInput = Omit<Toast, 'id' | 'createdAt'> & { id?: string }

let toastListeners: ((toasts: Toast[]) => void)[] = []
let toastSinks: ((toast: Toast) => void)[] = []
let toasts: Toast[] = []

const notifyListeners = () => {
  toastListeners.forEach((listener) => listener([...toasts]))
}

const toastTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function subscribeToToasts(sink: (toast: Toast) => void) {
  toastSinks.push(sink)
  return () => {
    toastSinks = toastSinks.filter((s) => s !== sink)
  }
}

function removeToast(id: string) {
  const timer = toastTimers.get(id)
  if (timer) clearTimeout(timer)
  toastTimers.delete(id)
  toasts = toasts.filter((t) => t.id !== id)
  notifyListeners()
}

// Standalone toast function that can be used outside of React components
export function toast({ id: givenId, title, description, variant = 'default', className, action, actionHint, actionTarget, duration, href, accountId, history }: ToastInput) {
  const id = givenId ?? crypto.randomUUID()
  const newToast: Toast = { id, title, description, variant, className, action, actionHint, actionTarget, duration, href, accountId, history, createdAt: Date.now() }

  const existingTimer = toastTimers.get(id)
  if (existingTimer) clearTimeout(existingTimer)
  toastTimers.delete(id)
  toasts = [...toasts.filter((t) => t.id !== id), newToast]
  notifyListeners()
  toastSinks.forEach((sink) => {
    try {
      sink(newToast)
    } catch {
      // a recorder failure must never block the toast
    }
  })

  const ms = duration ?? DEFAULT_TOAST_DURATION
  if (Number.isFinite(ms) && ms > 0) {
    toastTimers.set(id, setTimeout(() => removeToast(id), ms))
  }

  return id
}

export function dismissToast(toastId: string) {
  removeToast(toastId)
}

export function useToast() {
  const [, setLocalToasts] = useState<Toast[]>([])

  useEffect(() => {
    const listener = (newToasts: Toast[]) => setLocalToasts(newToasts)
    toastListeners.push(listener)
    return () => {
      toastListeners = toastListeners.filter((l) => l !== listener)
    }
  }, [])

  const dismiss = useCallback((toastId: string) => dismissToast(toastId), [])

  return {
    toast,
    dismiss,
    toasts,
  }
}
