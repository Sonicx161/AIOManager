import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { X } from 'lucide-react'

interface TagSelectorProps {
    value: string[]
    onChange: (tags: string[]) => void
    options: string[]
    placeholder?: string
}

export function TagSelector({ value, onChange, options, placeholder }: TagSelectorProps) {
    const availableOptions = options.filter(opt => !value.includes(opt))

    const handleSelect = (tag: string) => {
        onChange([...value, tag])
    }

    const removeTag = (tag: string) => {
        onChange(value.filter((t) => t !== tag))
    }

    return (
        <div className="space-y-3">
            {/* Chips Container */}
            <div className="flex flex-wrap gap-2 min-h-[32px]">
                {value.length === 0 && (
                    <span className="text-sm text-muted-foreground py-1 italic">No tags selected</span>
                )}
                {value.map((tag) => (
                    <Badge key={tag} variant="destructive" className="gap-1 pr-1">
                        {tag}
                        <div
                            role="button"
                            className="rounded-full hover:bg-black/20 p-0.5 cursor-pointer"
                            onClick={() => removeTag(tag)}
                        >
                            <X className="h-3 w-3" />
                        </div>
                    </Badge>
                ))}
            </div>

            {/* Select Dropdown */}
            <Select value="" onValueChange={handleSelect} disabled={availableOptions.length === 0}>
                <SelectTrigger>
                    <SelectValue placeholder={
                        availableOptions.length === 0
                            ? "All tags selected"
                            : value.length > 0
                                ? "Select more tags..."
                                : placeholder || "Select tag to remove..."
                    } />
                </SelectTrigger>
                <SelectContent>
                    {availableOptions.map(opt => (
                        <SelectItem key={opt} value={opt}>
                            {opt}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    )
}
