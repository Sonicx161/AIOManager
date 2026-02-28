import { motion } from 'framer-motion'
import { FileDown, RefreshCw, Check, Zap, Trash2, ShieldCheck, Settings, Heart } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AnimatedIconProps {
    className?: string
    isAnimating?: boolean
}

export const AnimatedUpdateIcon = ({ className, isAnimating = false }: AnimatedIconProps) => {
    return (
        <div className={cn("relative flex items-center justify-center", className)}>
            <motion.div
                animate={isAnimating ? {
                    y: [0, 3, 0],
                    opacity: [1, 0.5, 1],
                } : {}}
                transition={{
                    duration: 1.2,
                    repeat: Infinity,
                    ease: "easeInOut",
                }}
            >
                <FileDown className="h-full w-full" />
            </motion.div>
            {isAnimating && (
                <motion.div
                    className="absolute inset-0 border-2 border-primary rounded-full"
                    initial={{ scale: 0.8, opacity: 0.5 }}
                    animate={{ scale: 1.5, opacity: 0 }}
                    transition={{
                        duration: 1,
                        repeat: Infinity,
                        ease: "easeOut",
                    }}
                />
            )}
        </div>
    )
}

export const AnimatedRefreshIcon = ({ className, isAnimating = false }: AnimatedIconProps) => {
    return (
        <motion.div
            animate={{
                rotate: isAnimating ? 360 : 0
            }}
            transition={isAnimating ? {
                duration: 1,
                repeat: Infinity,
                ease: "linear",
            } : {
                duration: 0.3
            }}
            className={cn("flex items-center justify-center", className)}
        >
            <RefreshCw className="h-full w-full" />
        </motion.div>
    )
}

export const AnimatedCheckIcon = ({ className, isAnimating = false }: AnimatedIconProps) => {
    return (
        <motion.div
            initial={false}
            animate={isAnimating ? { scale: [1, 1.2, 1] } : {}}
            transition={{ duration: 0.3 }}
            className={cn("flex items-center justify-center", className)}
        >
            <Check className="h-full w-full" />
        </motion.div>
    )
}

export const AnimatedZapIcon = ({ className, isAnimating = false }: AnimatedIconProps) => {
    return (
        <motion.div
            animate={isAnimating ? {
                scale: [1, 1.1, 1],
                filter: ["brightness(1)", "brightness(1.5)", "brightness(1)"]
            } : {}}
            transition={{
                duration: 0.8,
                repeat: Infinity,
                ease: "easeInOut",
            }}
            className={cn("flex items-center justify-center", className)}
        >
            <Zap className="h-full w-full" />
        </motion.div>
    )
}

export const AnimatedTrashIcon = ({ className, isAnimating = false }: AnimatedIconProps) => {
    return (
        <motion.div
            whileHover={{
                rotate: [0, -10, 10, -10, 0],
                transition: { duration: 0.4 }
            }}
            animate={isAnimating ? {
                scale: [1, 0.9, 1.1, 0],
                opacity: [1, 1, 1, 0]
            } : {}}
            className={cn("flex items-center justify-center", className)}
        >
            <Trash2 className="h-full w-full" />
        </motion.div>
    )
}

export const AnimatedShieldIcon = ({ className, isAnimating = false }: AnimatedIconProps) => {
    return (
        <motion.div
            animate={isAnimating ? {
                scale: [1, 1.1, 1],
                opacity: [0.8, 1, 0.8]
            } : {}}
            transition={{
                duration: 2,
                repeat: Infinity,
                ease: "easeInOut",
            }}
            className={cn("flex items-center justify-center", className)}
        >
            <ShieldCheck className="h-full w-full" />
        </motion.div>
    )
}

export const AnimatedSettingsIcon = ({ className, isAnimating = false }: AnimatedIconProps) => {
    return (
        <motion.div
            whileHover={{ rotate: 90 }}
            animate={{
                rotate: isAnimating ? 360 : 0
            }}
            transition={{ duration: 0.5 }}
            className={cn("flex items-center justify-center", className)}
        >
            <Settings className="h-full w-full" />
        </motion.div>
    )
}

export const AnimatedHeartIcon = ({ className, isAnimating = false }: AnimatedIconProps) => {
    return (
        <motion.div
            whileHover={{ scale: 1.2 }}
            whileTap={{ scale: 0.8 }}
            animate={isAnimating ? {
                scale: [1, 1.4, 1],
                color: ["currentcolor", "#ef4444", "currentcolor"]
            } : {}}
            className={cn("flex items-center justify-center", className)}
        >
            <Heart className="h-full w-full" />
        </motion.div>
    )
}
