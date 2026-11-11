"use client"

import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { cn } from "@/lib/utils"

const Popover = PopoverPrimitive.Root

const PopoverClose = PopoverPrimitive.Close

const PopoverTrigger = React.forwardRef<
    React.ElementRef<typeof PopoverPrimitive.Trigger>,
    React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>((props, ref) => <PopoverPrimitive.Trigger data-theme-part="button" ref={ref} {...props} />)
PopoverTrigger.displayName = PopoverPrimitive.Trigger.displayName

const PopoverContent = React.forwardRef<
    React.ElementRef<typeof PopoverPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (<PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
        data-theme-part="popover"
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
            "z-[100] w-72 rounded-xl border bg-card p-4 text-card-foreground shadow-2xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            // Cider's open spring for popovers: the zoom entrance overshoots slightly.
            "data-[state=open]:duration-[240ms] data-[state=open]:ease-[cubic-bezier(0.38,0.8,0.32,1.07)] motion-reduce:animate-none",
            className
        )}
        {...props}
    />
</PopoverPrimitive.Portal>))
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverClose, PopoverTrigger, PopoverContent }
