export const PHONE_QUERY = '(max-width: 639px)'
export const PHONE_MAX_WIDTH = 639

export type MenuPresentation = 'popover' | 'sheet'

export function isPhoneWidth(viewportWidth: number): boolean {
  return viewportWidth <= PHONE_MAX_WIDTH
}

/** Panels without selectable items (custom content) always stay popovers. */
export function pickMenuPresentation(phone: boolean, hasMenuItems: boolean): MenuPresentation {
  return phone && hasMenuItems ? 'sheet' : 'popover'
}

/** Stable partition: destructive entries move after the rest, original order otherwise kept. */
export function destructiveLast<T>(entries: readonly T[], isDestructive: (entry: T) => boolean): T[] {
  const regular: T[] = []
  const destructive: T[] = []
  for (const entry of entries) (isDestructive(entry) ? destructive : regular).push(entry)
  return [...regular, ...destructive]
}
