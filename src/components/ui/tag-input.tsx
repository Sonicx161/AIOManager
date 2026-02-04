import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { X } from 'lucide-react'
import { KeyboardEvent, useState } from 'react'

interface TagInputProps {
    value: string[]
    onChange: (tags: string[]) => void
    placeholder?: string
    suggestions?: string[]
}

export function TagInput({ value, onChange, placeholder, suggestions }: TagInputProps) {
    const [inputValue, setInputValue] = useState('')

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            const newTag = inputValue.trim()
            if (newTag && !value.includes(newTag)) {
                onChange([...value, newTag])
                setInputValue('')
            }
        } else if (e.key === 'Backspace' && !inputValue && value.length > 0) {
            onChange(value.slice(0, -1))
        }
    }

    const removeTag = (tag: string) => {
        onChange(value.filter((t) => t !== tag))
    }

    return (
        <div className="flex flex-wrap gap-2 p-2 border rounded-md bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ring-offset-background">
            {value.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                    {tag}
                    <div
                        role="button"
                        className="rounded-full hover:bg-destructive/20 p-0.5 cursor-pointer"
                        onClick={() => removeTag(tag)}
                    >
                        <X className="h-3 w-3" />
                    </div>
                </Badge>
            ))}
            <div className="flex-1 min-w-[120px]">
                <Input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={value.length === 0 ? placeholder : ''}
                    className="border-0 focus-visible:ring-0 px-0 h-6 text-sm bg-transparent placeholder:text-muted-foreground"
                    list={suggestions ? "tag-suggestions" : undefined}
                />
                {suggestions && (
                    <datalist id="tag-suggestions">
                        {suggestions.map(s => <option key={s} value={s} />)}
                    </datalist>
                )}
            </div>
        </div>
    )
}
