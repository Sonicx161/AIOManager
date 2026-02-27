import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { getTagColor } from "@/lib/tag-utils"

interface AddonTagProps {
    tag: string
    className?: string
    isCompact?: boolean
}

export function AddonTag({ tag, className, isCompact = false }: AddonTagProps) {
    const color = getTagColor(tag)

    if (isCompact) {
        return (
            <Badge
                variant="secondary"
                className={cn(
                    "font-mono text-[9px] pointer-events-none uppercase tracking-wider font-bold mb-0.5 px-1.5 py-0.5 border",
                    className
                )}
                style={{
                    background: color.bg,
                    color: color.text,
                    border: `1px solid ${color.border}`
                }}
            >
                {tag}
            </Badge>
        )
    }

    return (
        <Badge
            variant="secondary"
            className={cn(
                "font-mono text-[10px] pointer-events-none uppercase tracking-wider font-bold px-2 py-0.5 border",
                className
            )}
            style={{
                background: color.bg,
                color: color.text,
                border: `1px solid ${color.border}`
            }}
        >
            {tag}
        </Badge>
    )
}
