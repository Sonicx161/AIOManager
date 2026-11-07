import { useSyncExternalStore } from 'react'
import { DEFAULT_TOAST_DURATION, dismissToast, toast } from '../hooks/use-toast.ts'

export interface UndoableOptions {
  scope: string
  ids: string[]
  title: string
  description?: string
  duration?: number
  commit: () => void | Promise<void>
  onUndo?: () => void
  // pagehide interrupts the countdown: 'cancel' keeps the item (nothing was written),
  // 'commit' starts the real operation immediately.
  onUnload?: 'cancel' | 'commit'
}

export interface UndoHandle {
  cancel: () => boolean
  commitNow: () => Promise<void>
  settled: () => boolean
}

interface Pending {
  commitNow: () => Promise<void>
  cancel: () => boolean
  unload: 'cancel' | 'commit'
}

const pendingByScope = new Map<string, Map<string, number>>()
const active = new Set<Pending>()
const listeners = new Set<() => void>()
const snapshots = new Map<string, ReadonlySet<string>>()
const EMPTY: ReadonlySet<string> = new Set()
let unloadBound = false

function emit(scope: string) {
  snapshots.set(scope, new Set(pendingByScope.get(scope)?.keys() ?? []))
  listeners.forEach((l) => l())
}

function hold(scope: string, ids: string[]) {
  const map = pendingByScope.get(scope) ?? new Map<string, number>()
  for (const id of ids) map.set(id, (map.get(id) ?? 0) + 1)
  pendingByScope.set(scope, map)
  emit(scope)
}

function release(scope: string, ids: string[]) {
  const map = pendingByScope.get(scope)
  if (!map) return
  for (const id of ids) {
    const n = (map.get(id) ?? 0) - 1
    if (n > 0) map.set(id, n)
    else map.delete(id)
  }
  emit(scope)
}

export function isUndoPending(scope: string, id: string): boolean {
  return (pendingByScope.get(scope)?.get(id) ?? 0) > 0
}

export function pendingUndoTargets(scope: string): string[] {
  return [...(pendingByScope.get(scope)?.keys() ?? [])]
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePendingUndoIds(scope: string): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => snapshots.get(scope) ?? EMPTY, () => EMPTY)
}

export function useIsUndoPending(scope: string, id: string): boolean {
  return usePendingUndoIds(scope).has(id)
}

function bindUnload() {
  if (unloadBound || typeof window === 'undefined') return
  unloadBound = true
  window.addEventListener('pagehide', () => flushUndoables())
}

export function flushUndoables() {
  for (const p of [...active]) {
    if (p.unload === 'commit') p.commitNow().catch(() => {})
    else p.cancel()
  }
}

export function scheduleUndoable(options: UndoableOptions): UndoHandle {
  const { scope, ids, title, description, commit, onUndo, onUnload = 'cancel' } = options
  const duration = options.duration ?? DEFAULT_TOAST_DURATION
  const toastId = `undo:${scope}:${ids.join('|')}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  let state: 'pending' | 'committed' | 'cancelled' = 'pending'
  let timer: ReturnType<typeof setTimeout> | null = null

  const pending: Pending = {
    unload: onUnload,
    cancel: () => {
      if (state !== 'pending') return false
      state = 'cancelled'
      if (timer) clearTimeout(timer)
      active.delete(pending)
      dismissToast(toastId)
      release(scope, ids)
      onUndo?.()
      return true
    },
    commitNow: async () => {
      if (state !== 'pending') return
      state = 'committed'
      if (timer) clearTimeout(timer)
      active.delete(pending)
      dismissToast(toastId)
      try {
        await commit()
      } finally {
        release(scope, ids)
      }
    },
  }

  active.add(pending)
  hold(scope, ids)
  bindUnload()
  timer = setTimeout(() => { pending.commitNow().catch(() => {}) }, duration)
  toast({
    id: toastId,
    title,
    description,
    duration,
    history: false,
    action: { label: 'Undo', onClick: () => { pending.cancel() } },
  })

  return { cancel: pending.cancel, commitNow: pending.commitNow, settled: () => state !== 'pending' }
}
