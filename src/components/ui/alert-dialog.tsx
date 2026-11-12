import * as React from "react"
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

const AlertDialog = AlertDialogPrimitive.Root

const AlertDialogTrigger = React.forwardRef<
    React.ElementRef<typeof AlertDialogPrimitive.Trigger>,
    React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Trigger>
>((props, ref) => <AlertDialogPrimitive.Trigger data-theme-part="button" ref={ref} {...props} />)
AlertDialogTrigger.displayName = AlertDialogPrimitive.Trigger.displayName

const AlertDialogPortal = AlertDialogPrimitive.Portal

const AlertDialogOverlay = React.forwardRef<
    React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
    React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (<AlertDialogPrimitive.Overlay
    data-theme-part="dialog-overlay"
    data-theme-overlay=""
    className={cn(
        "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm transition-opacity duration-150 data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
        className
    )}
    {...props}
    ref={ref}
/>))
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName

const AlertDialogContent = React.forwardRef<
    React.ElementRef<typeof AlertDialogPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(({ className, ...props }, ref) => (<AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogPrimitive.Content
        data-theme-part="dialog"
        data-theme-overlay=""
        ref={ref}
        className={cn(
            "fixed left-[50%] top-[50%] z-50 grid w-[95vw] sm:w-full max-w-sm translate-x-[-50%] translate-y-[-50%] gap-0 overflow-y-auto max-h-[95vh]",
            "rounded-xl border border-border/40",
            "bg-card",
            "shadow-[0_24px_64px_hsl(0_0%_0%/0.24)]",
            "transition-opacity duration-150 ease-out data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
            className
        )}
        {...props}
    />
</AlertDialogPortal>))
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName

const AlertDialogHeader = ({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={cn(
            "flex flex-col space-y-2 px-6 pb-5 pt-6 text-center sm:text-left",
            className
        )}
        {...props}
    />
)
AlertDialogHeader.displayName = "AlertDialogHeader"

const AlertDialogFooter = ({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={cn(
            "grid grid-cols-2 gap-3 px-4 pb-4 pt-0 [&_button]:h-11 [&_button]:rounded-full [&_button]:px-5 sm:grid-cols-2",
            className
        )}
        {...props}
    />
)
AlertDialogFooter.displayName = "AlertDialogFooter"

const AlertDialogTitle = React.forwardRef<
    React.ElementRef<typeof AlertDialogPrimitive.Title>,
    React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (<AlertDialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-bold tracking-tight", className)}
    {...props}
/>))
AlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName

const AlertDialogDescription = React.forwardRef<
    React.ElementRef<typeof AlertDialogPrimitive.Description>,
    React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (<AlertDialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
/>))
AlertDialogDescription.displayName =
    AlertDialogPrimitive.Description.displayName

const AlertDialogAction = React.forwardRef<
    React.ElementRef<typeof AlertDialogPrimitive.Action>,
    React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>
>(({ className, ...props }, ref) => (<AlertDialogPrimitive.Action
    data-theme-part="button"
    data-variant="default"
    ref={ref}
    className={cn(buttonVariants(), "h-11 rounded-full", className)}
    {...props}
/>))
AlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName

const AlertDialogCancel = React.forwardRef<
    React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
    React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(({ className, ...props }, ref) => (<AlertDialogPrimitive.Cancel
    data-theme-part="button"
    data-variant="subtle"
    ref={ref}
    className={cn(
        buttonVariants({ variant: "subtle" }),
        "h-11 rounded-full",
        className
    )}
    {...props}
/>))
AlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName

export {
    AlertDialog,
    AlertDialogPortal,
    AlertDialogOverlay,
    AlertDialogTrigger,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogFooter,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogAction,
    AlertDialogCancel,
}
