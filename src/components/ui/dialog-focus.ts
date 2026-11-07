export interface FocusCandidate {
  isConnected: boolean
}

// First connected candidate the dialog may return focus to on close.
export function pickReturnFocus<T extends FocusCandidate>(
  candidates: Array<T | null | undefined>,
  isEligible: (el: T) => boolean,
): T | null {
  for (const el of candidates) {
    if (el && el.isConnected && isEligible(el)) return el
  }
  return null
}

const ACTIVATABLE = 'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [role="button"]'

let lastActivated: HTMLElement | null = null
let tracking = false

// Safari and scripted clicks do not focus the clicked button, so remember it as a fallback.
export function trackActivations(doc: Document): void {
  if (tracking) return
  tracking = true
  doc.addEventListener('click', (e) => {
    const target = e.target
    lastActivated = target instanceof Element ? target.closest<HTMLElement>(ACTIVATABLE) : null
  }, true)
  doc.addEventListener('focusin', (e) => {
    if (e.target !== lastActivated) lastActivated = null
  }, true)
}

export function getLastActivated(): HTMLElement | null {
  return lastActivated
}
