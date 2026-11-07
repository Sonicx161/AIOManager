export const GESTURE_SLOP = 10
export const PULL_THRESHOLD = 64
export const PULL_MAX = 112
export const PULL_RESISTANCE = 0.5
export const SWIPE_ACTIONS_WIDTH = 176
export const SWIPE_VELOCITY = 0.4
export const SHEET_DISMISS_OFFSET = 90
export const SHEET_DISMISS_VELOCITY = 500

export type GestureAxis = 'pending' | 'horizontal' | 'vertical'
export type PullPhase = 'idle' | 'pulling' | 'ready'

export function classifyAxis(dx: number, dy: number, slop = GESTURE_SLOP): GestureAxis {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax <= slop && ay <= slop) return 'pending'
  return ax > ay ? 'horizontal' : 'vertical'
}

export function pullDistance(dy: number, resistance = PULL_RESISTANCE, max = PULL_MAX): number {
  if (!(dy > 0)) return 0
  return Math.min(max, dy * resistance)
}

export function pullPhase(distance: number, threshold = PULL_THRESHOLD): PullPhase {
  if (distance >= threshold) return 'ready'
  return distance > 0 ? 'pulling' : 'idle'
}

export function clampSwipeOffset(startOpen: boolean, dx: number, width = SWIPE_ACTIONS_WIDTH): number {
  const base = startOpen ? -width : 0
  return Math.max(-width, Math.min(0, base + dx))
}

/** Velocity is px per ms, negative toward the left. */
export function settleSwipe(startOpen: boolean, dx: number, velocityX: number, width = SWIPE_ACTIONS_WIDTH): boolean {
  if (velocityX <= -SWIPE_VELOCITY) return true
  if (velocityX >= SWIPE_VELOCITY) return false
  return startOpen ? dx < width / 3 : dx <= -width / 3
}

export function shouldDismissSheet(offsetY: number, velocityY: number): boolean {
  return offsetY > SHEET_DISMISS_OFFSET || velocityY > SHEET_DISMISS_VELOCITY
}
