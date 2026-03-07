import { Theme, ThemeOption, THEME_OPTIONS } from '@/contexts/ThemeContext'
import { Check } from 'lucide-react'

function ThemeCard({ option, selected, onSelect }: { option: ThemeOption; selected: boolean; onSelect: (id: Theme) => void }) {
    const { preview } = option

    const isLightAccent = (() => {
        const hex = preview.accent.replace('#', '')
        const r = parseInt(hex.slice(0, 2), 16)
        const g = parseInt(hex.slice(2, 4), 16)
        const b = parseInt(hex.slice(4, 6), 16)
        return (r * 299 + g * 587 + b * 114) / 1000 > 128
    })()

    return (
        <button
            onClick={() => onSelect(option.id)}
            className={`relative w-full rounded-xl border-2 transition-all text-left shadow-sm focus:outline-none hover:scale-[1.02] ${selected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}`}
            style={{
                borderColor: preview.textMuted + '40',
                background: preview.background,
                color: preview.text,
            }}
        >
            <div className="p-3">
                {/* Mini preview */}
                <div
                    className="w-full h-20 rounded-lg mb-3 overflow-hidden"
                    style={{ background: preview.surface, border: `1px solid ${preview.textMuted}30` }}
                >
                    {/* Fake header bar */}
                    <div
                        className="px-2 py-1.5 flex items-center justify-between"
                        style={{ borderBottom: `1px solid ${preview.textMuted}20` }}
                    >
                        <div className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-full" style={{ background: preview.accent }} />
                            <div className="h-1.5 rounded-full w-10" style={{ background: preview.text, opacity: 0.5 }} />
                        </div>
                        <div className="h-1.5 rounded w-4" style={{ background: preview.accent, opacity: 0.7 }} />
                    </div>

                    {/* Fake addon row */}
                    <div className="px-2 py-1.5 flex items-center gap-1.5">
                        <div className="w-5 h-5 rounded flex-shrink-0" style={{ background: preview.accent + '30' }} />
                        <div className="flex-1 space-y-1">
                            <div className="h-1.5 rounded-full w-3/4" style={{ background: preview.text, opacity: 0.7 }} />
                            <div className="h-1 rounded-full w-1/2" style={{ background: preview.textMuted, opacity: 0.4 }} />
                        </div>
                        <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: preview.accent + '60' }} />
                    </div>

                    {/* Second row, slightly faded for depth */}
                    <div className="px-2 py-1 flex items-center gap-1.5" style={{ opacity: 0.5 }}>
                        <div className="w-5 h-5 rounded flex-shrink-0" style={{ background: preview.textMuted + '30' }} />
                        <div className="flex-1 space-y-1">
                            <div className="h-1.5 rounded-full w-2/3" style={{ background: preview.text, opacity: 0.5 }} />
                        </div>
                    </div>
                </div>

                {/* Label */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-lg">{option.emoji}</span>
                        <span className="font-semibold text-sm" style={{ color: preview.text }}>
                            {option.label}
                        </span>
                    </div>
                    {selected && (
                        <div
                            className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                            style={{ background: preview.accent }}
                        >
                            <Check className={`w-3 h-3 ${isLightAccent ? 'text-black' : 'text-white'}`} />
                        </div>
                    )}
                </div>
                <p
                    className={`text-xs mt-1 line-clamp-2 ${option.italic ? 'italic' : ''}`}
                    style={{ color: preview.textMuted }}
                >
                    {option.description}
                </p>
            </div>
        </button>
    )
}

interface ThemeSectionProps {
    theme: Theme
    setTheme: (theme: Theme) => void
}

export function ThemeSection({ theme, setTheme }: ThemeSectionProps) {
    return (
        <div className="p-6 rounded-xl border bg-card/50 space-y-6">
            <div className="space-y-4">
                <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Standard Themes</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {THEME_OPTIONS.filter(opt => opt.category === 'standard').map(option => (
                        <ThemeCard
                            key={option.id}
                            option={option}
                            selected={theme === option.id}
                            onSelect={setTheme}
                        />
                    ))}
                </div>
            </div>

            <div className="space-y-4">
                <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Community Themes</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {THEME_OPTIONS.filter(opt => opt.category === 'community').map(option => (
                        <ThemeCard
                            key={option.id}
                            option={option}
                            selected={theme === option.id}
                            onSelect={setTheme}
                        />
                    ))}
                </div>
            </div>
        </div>
    )
}
