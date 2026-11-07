// Module-level ref-counted scroll lock. Nested dialogs each acquire; the page
// scroll stays locked until the last one releases.
export interface ScrollLockView {
  innerWidth: number
  documentElement: {
    clientWidth: number
    style: { overflow: string; paddingRight: string }
  }
}

let openDialogs = 0

export function scrollLockCount(): number {
  return openDialogs
}

export function acquireScrollLock(view: ScrollLockView): void {
  openDialogs++
  if (openDialogs > 1) return
  const scrollbarWidth = view.innerWidth - view.documentElement.clientWidth
  view.documentElement.style.overflow = 'hidden'
  view.documentElement.style.paddingRight = `${scrollbarWidth}px`
}

export function releaseScrollLock(view: ScrollLockView): void {
  if (openDialogs === 0) return
  openDialogs--
  if (openDialogs > 0) return
  view.documentElement.style.overflow = ''
  view.documentElement.style.paddingRight = ''
}
