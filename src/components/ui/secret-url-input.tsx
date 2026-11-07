import { useState } from 'react'
import type { Ref } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { maskSecretUrl } from '@/lib/mask-secret-url'
import { useUIStore } from '@/store/uiStore'
import { cn } from '@/lib/utils'

interface SecretUrlInputProps {
    value: string
    onChange: (value: string) => void
    placeholder?: string
    className?: string
    id?: string
    ariaLabel?: string
    inputRef?: Ref<HTMLInputElement>
}

// Displays a bearer URL masked and read-only in privacy mode; focus or the Eye toggle reveals the raw value for editing. The stored value stays raw.
export function SecretUrlInput({ value, onChange, placeholder, className, id, ariaLabel, inputRef }: SecretUrlInputProps) {
    const privacyOn = useUIStore(s => s.isPrivacyModeEnabled)
    const [revealed, setRevealed] = useState(false)
    const [focused, setFocused] = useState(false)
    const masked = privacyOn && !revealed && !focused && !!value

    return (
        <div className="relative min-w-0 flex-1">
            <Input
                id={id}
                ref={inputRef}
                aria-label={ariaLabel}
                placeholder={placeholder}
                value={masked ? maskSecretUrl(value) : value}
                onChange={(e) => onChange(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                readOnly={masked}
                className={cn('bg-muted/30 border-border', className, privacyOn && value && 'pr-11 sm:pr-9')}
            />
            {privacyOn && value && (
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={revealed ? 'Hide URL' : 'Show URL'}
                    aria-pressed={revealed}
                    onClick={() => setRevealed(v => !v)}
                    className="absolute right-1 top-1/2 h-11 w-11 -translate-y-1/2 text-muted-foreground hover:text-foreground sm:h-8 sm:w-8"
                >
                    {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
            )}
        </div>
    )
}
