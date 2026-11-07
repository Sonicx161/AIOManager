import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { motion, useReducedMotion } from "framer-motion"

import { cn } from "@/lib/utils"

interface ProgressProps extends Omit<React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>, "value"> {
  value?: number | null
  /** Work of unknown length. Also implied by value={null}. */
  indeterminate?: boolean
  shimmer?: boolean
}

const DEFAULT_MAX = 100

const Progress = React.forwardRef<
    React.ElementRef<typeof ProgressPrimitive.Root>,
    ProgressProps
>(({ className, value, max, indeterminate = false, shimmer = false, ...props }, ref) => {
  const reduceMotion = useReducedMotion()
  const safeMax = typeof max === "number" && Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX
  const isIndeterminate = indeterminate || value === null
  const clamped = typeof value === "number" && Number.isFinite(value) ? Math.min(safeMax, Math.max(0, value)) : 0
  const percent = (clamped / safeMax) * 100

  return (
    <ProgressPrimitive.Root
      data-theme-part="progress"
      ref={ref}
      value={isIndeterminate ? null : clamped}
      max={safeMax}
      className={cn(
          "relative h-4 w-full overflow-hidden rounded-full bg-secondary",
          className
      )}
      {...props}
    >
      {isIndeterminate ? (
        reduceMotion ? (
          <div data-theme-part="progress-indicator" className="h-full w-full rounded-full bg-primary opacity-50" />
        ) : (
          <motion.div
            data-theme-part="progress-indicator"
            className="h-full w-1/3 rounded-full bg-primary"
            initial={{ x: "-100%" }}
            animate={{ x: "300%" }}
            transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity }}
          />
        )
      ) : (
        <motion.div
          data-theme-part="progress-indicator"
          className="h-full bg-primary rounded-full relative overflow-hidden"
          initial={reduceMotion ? false : { width: "0%" }}
          animate={{ width: `${percent}%` }}
          transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 100, damping: 20 }}
        >
          <div className="absolute right-0 top-0 bottom-0 w-4 bg-gradient-to-r from-transparent to-white/20 rounded-full" />

          {shimmer && !reduceMotion && percent > 0 && (
            <motion.div
              aria-hidden
              className="absolute inset-0 bg-gradient-to-r from-transparent via-white/15 to-transparent"
              initial={{ x: "-100%" }}
              animate={{ x: "100%" }}
              transition={{ duration: 2, ease: "linear", repeat: Infinity }}
            />
          )}
        </motion.div>
      )}
    </ProgressPrimitive.Root>
  )
})
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
