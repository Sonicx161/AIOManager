import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    data-theme-part="tabs-list"
    ref={ref}
    className={cn(
      "inline-flex h-auto w-fit max-w-full flex-wrap items-center justify-start gap-1.5 rounded-2xl border border-border/40 bg-card p-1.5 text-muted-foreground shadow-sm",
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & { animated?: boolean }
>(({ className, children, animated: _animated = true, ...props }, ref) => {
  const activeClass = "data-[state=active]:border data-[state=active]:border-foreground/10 data-[state=active]:bg-foreground/[0.08] data-[state=active]:text-foreground data-[state=active]:shadow-none"
  return (
    <TabsPrimitive.Trigger
      data-theme-part="tab"
      ref={ref}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-xl border border-transparent px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        "text-muted-foreground hover:text-foreground",
        activeClass,
        className
      )}
      {...props}
    >
      <span className="relative z-10 flex items-center justify-center gap-1.5">
        {children}
      </span>
    </TabsPrimitive.Trigger>
  )
})
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content> & { animated?: boolean }
>(({ className, animated = true, ...props }, ref) => (
  <TabsPrimitive.Content
    data-theme-part="tab-panel"
    ref={ref}
    className={cn(
      "mt-2 outline-none",
      animated && "data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:duration-150",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
