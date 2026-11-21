const SPRING = { type: 'spring', stiffness: 500, damping: 30 } as const
const INSTANT = { duration: 0 } as const
const DOT_VARIANTS = {
  hidden: (crossfade: boolean) => (crossfade ? { opacity: 0 } : { opacity: 0, scale: 0 }),
  shown: { opacity: 1, scale: 1 },
}

// No layoutId: a shared-layout handoff caught mid scale animation drew the dot at 1/scale its size (issue #108).
export function navDotMotion(crossfade: boolean, reduceMotion: boolean) {
  return {
    variants: DOT_VARIANTS,
    custom: crossfade,
    initial: 'hidden',
    animate: 'shown',
    exit: 'hidden',
    transition: reduceMotion ? INSTANT : SPRING,
  }
}
