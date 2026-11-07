'use client'

import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

const TooltipProvider = TooltipPrimitive.Provider
const TooltipRoot = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger
const TooltipPortal = TooltipPrimitive.Portal

const TooltipContent = React.forwardRef<
    React.ElementRef<typeof TooltipPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, children, ...props }, ref) => (
    <TooltipPrimitive.Content
        data-theme-part="tooltip"
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
            'z-50 overflow-hidden rounded-lg border border-border/40 bg-card px-2.5 py-1.5 text-xs font-medium text-card-foreground shadow-lg',
            'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
            'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            className
        )}
        {...props}
    >
        {children}
        <TooltipPrimitive.Arrow className="fill-border/60" width={8} height={4} />
    </TooltipPrimitive.Content>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

interface TooltipProps {
    content: React.ReactNode
    children: React.ReactNode
    side?: 'top' | 'right' | 'bottom' | 'left'
    align?: 'start' | 'center' | 'end'
    delayDuration?: number
    className?: string
    disabled?: boolean
}

function Tooltip({
    content,
    children,
    side = 'top',
    align = 'center',
    delayDuration = 700,
    className,
    disabled = false,
}: TooltipProps) {
    const [open, setOpen] = React.useState(false)
    const triggerRef = React.useRef<React.ElementRef<typeof TooltipPrimitive.Trigger>>(null)
    const contentRef = React.useRef<React.ElementRef<typeof TooltipPrimitive.Content>>(null)
    // The portal subtree (positioning, arrow, animation) only mounts around opens:
    // lists render one tooltip trigger per card, so the heavy part stays out of the
    // resting tree while Root + Trigger stay put from the first render. The unmount
    // lingers so the close animation plays out.
    const [contentMounted, setContentMounted] = React.useState(false)
    React.useEffect(() => {
        if (open) {
            setContentMounted(true)
            return
        }
        const timer = setTimeout(() => setContentMounted(false), 250)
        return () => clearTimeout(timer)
    }, [open])

    React.useEffect(() => {
        if (!open) return

        const closeTooltip = () => setOpen(false)
        const handleFocusIn = (event: FocusEvent) => {
            const target = event.target as Node | null
            if (!target) return
            if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) return
            closeTooltip()
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            // An open tooltip consumes its Escape so a dialog sheet behind it does not also step back.
            if (event.key === 'Escape') { event.preventDefault(); closeTooltip() }
        }
        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') closeTooltip()
        }

        window.addEventListener('pointerdown', closeTooltip, true)
        window.addEventListener('scroll', closeTooltip, true)
        window.addEventListener('blur', closeTooltip)
        document.addEventListener('focusin', handleFocusIn)
        document.addEventListener('keydown', handleKeyDown, true)
        document.addEventListener('visibilitychange', handleVisibilityChange)

        return () => {
            window.removeEventListener('pointerdown', closeTooltip, true)
            window.removeEventListener('scroll', closeTooltip, true)
            window.removeEventListener('blur', closeTooltip)
            document.removeEventListener('focusin', handleFocusIn)
            document.removeEventListener('keydown', handleKeyDown, true)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [open])

    if (disabled || !content) return <>{children}</>

    return (
        <TooltipRoot open={open} onOpenChange={setOpen} delayDuration={delayDuration}>
            <TooltipTrigger ref={triggerRef} asChild>
                {React.isValidElement(children) ? children : <span>{children}</span>}
            </TooltipTrigger>
            {contentMounted && (
                <TooltipPortal>
                    <TooltipContent ref={contentRef} side={side} align={align} className={className}>
                        {content}
                    </TooltipContent>
                </TooltipPortal>
            )}
        </TooltipRoot>
    )
}

export {
    Tooltip,
    TooltipRoot,
    TooltipTrigger,
    TooltipContent,
    TooltipProvider,
    TooltipPortal,
}
