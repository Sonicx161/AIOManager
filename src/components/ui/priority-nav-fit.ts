export interface NavFitInput {
  available: number
  widths: number[]
  moreWidth: number
  gap: number
  activeIndex: number
  epsilon?: number
}

export interface NavFitResult {
  overflow: boolean
  visibleCount: number
  swapped: boolean
}

// Half a pixel: ghost measurements are fractional while the container rect rounds.
export const NAV_FIT_EPSILON = 0.5

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

export function computeNavFit({ available, widths, moreWidth, gap, activeIndex, epsilon = NAV_FIT_EPSILON }: NavFitInput): NavFitResult {
  const count = widths.length
  if (count === 0) return { overflow: false, visibleCount: 0, swapped: false }
  const active = activeIndex >= 0 && activeIndex < count ? activeIndex : -1
  const natural = sum(widths) + gap * (count - 1)
  if (natural <= available + epsilon) return { overflow: false, visibleCount: count, swapped: false }
  for (let k = count - 1; k >= 1; k--) {
    const visible = active >= k ? [...widths.slice(0, k - 1), widths[active]] : widths.slice(0, k)
    if (sum(visible) + gap * k + moreWidth <= available + epsilon) {
      return { overflow: true, visibleCount: k, swapped: active >= k }
    }
  }
  return { overflow: true, visibleCount: 1, swapped: active >= 0 }
}

export function resolveNavVisibility<T>(items: readonly T[], fit: NavFitResult, activeIndex: number): { visible: T[]; hidden: T[] } {
  const count = items.length
  if (!fit.overflow) return { visible: [...items], hidden: [] }
  const visibleCount = Math.min(Math.max(fit.visibleCount, 1), count)
  const active = activeIndex >= 0 && activeIndex < count ? activeIndex : -1
  const visible = fit.swapped && active >= visibleCount
    ? [...items.slice(0, visibleCount - 1), items[active]]
    : items.slice(0, visibleCount)
  const visibleSet = new Set(visible)
  return { visible, hidden: items.filter(item => !visibleSet.has(item)) }
}

// The pill container is w-fit, so its own width follows its content and cannot say
// how much room it has. The available width comes from the stable full-width wrapper
// that carries the inset, minus that inset and the container's own padding and border.
export function resolveAvailableWidth(wrapperClientWidth: number, wrapperPaddingX: number, containerChrome: number): number {
  return wrapperClientWidth - wrapperPaddingX - containerChrome
}
