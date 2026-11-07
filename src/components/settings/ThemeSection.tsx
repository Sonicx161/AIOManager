import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Theme, ThemeOption, useTheme, CustomThemeData, ThemePalette } from '@/contexts/ThemeContext'
import { THEME_OPTIONS } from '@/data/themes'
import { Check, Plus, Pencil, Copy, Upload, Download, Import, Layers, Palette, Search, X } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { Tooltip } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { normalizeCommandText } from '@/lib/command-search'
import { createCustomThemeId, parseThemePalette } from '@/lib/theme-utils'

interface ThemeExportPayload {
    aioThemeVersion: 1
    theme: {
        name: string
        description?: string
        emoji: string
        base: 'dark' | 'light' | 'oled'
        hue: number
        saturation: number
        palette: Record<string, string>
        customCss?: string
        logoUrl?: string
    }
}

function themeToPayload(ct: CustomThemeData): ThemeExportPayload {
    return {
        aioThemeVersion: 1,
        theme: {
            name: ct.label,
            description: ct.description || undefined,
            emoji: ct.emoji,
            base: ct.base,
            hue: ct.hue,
            saturation: ct.saturation,
            palette: ct.palette as unknown as Record<string, string>,
            customCss: ct.customCss,
            logoUrl: ct.logoUrl,
        },
    }
}

function payloadToThemeData(payload: ThemeExportPayload): CustomThemeData {
    return {
        id: createCustomThemeId(),
        label: payload.theme.name,
        description: payload.theme.description,
        emoji: payload.theme.emoji,
        base: payload.theme.base,
        hue: payload.theme.hue,
        saturation: payload.theme.saturation,
        palette: parseThemePalette(payload.theme.palette)!,
        customCss: payload.theme.customCss,
        logoUrl: payload.theme.logoUrl,
    }
}

function validatePayload(data: unknown): data is ThemeExportPayload {
    const d = data as Record<string, unknown> | null
    if (!d || d.aioThemeVersion !== 1) return false
    const t = d.theme as Record<string, unknown> | undefined
    if (!t || typeof t !== 'object') return false
    if (typeof t.name !== 'string' || t.name.trim().length === 0) return false
    if (t.description !== undefined && typeof t.description !== 'string') return false
    if (t.base !== 'dark' && t.base !== 'light' && t.base !== 'oled') return false
    if (typeof t.emoji !== 'string') return false
    if (typeof t.hue !== 'number' || typeof t.saturation !== 'number') return false
    if (!Number.isFinite(t.hue) || t.hue < 0 || t.hue > 360) return false
    if (!Number.isFinite(t.saturation) || t.saturation < 0 || t.saturation > 100) return false
    if (t.customCss !== undefined && typeof t.customCss !== 'string') return false
    if (t.logoUrl !== undefined && typeof t.logoUrl !== 'string') return false
    return parseThemePalette(t.palette) !== null
}

function ThemeCard({ option, selected, onSelect, onEdit, onClone, onCopy, onDownload }: {
    option: ThemeOption; selected: boolean; onSelect: (id: Theme) => void
    onEdit?: () => void; onClone?: () => void; onCopy?: () => void; onDownload?: () => void
}) {
    const { preview } = option
    const { isLight } = useTheme()

    const isLightAccent = (() => {
        const hex = preview.accent.replace('#', '')
        const r = parseInt(hex.slice(0, 2), 16)
        const g = parseInt(hex.slice(2, 4), 16)
        const b = parseInt(hex.slice(4, 6), 16)
        return (r * 299 + g * 587 + b * 114) / 1000 > 128
    })()

    const isCustom = typeof option.id === 'string' && option.id.startsWith('custom-')
    const actionStyle = {
        background: preview.textMuted + '26',
        borderColor: preview.textMuted + '32',
        color: preview.text,
    }

    return (
        <div
            role="button"
            aria-label={`Select ${option.label} theme`}
            aria-pressed={selected}
            tabIndex={0}
            onClick={() => onSelect(option.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(option.id) } }}
            className={`group relative w-full h-full cursor-pointer rounded-2xl border-2 transition-[transform,opacity,box-shadow] duration-200 text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:shadow-lg hover:translate-y-[-2px] flex flex-col ${selected ? `ring-2 ${isLight ? 'ring-primary/25' : 'ring-primary/12'} ring-offset-2 ring-offset-background bg-primary/5` : ''}`}
            style={{
                borderColor: preview.textMuted + '40',
                background: preview.background,
                color: preview.text,
            }}
        >
            <div className="p-3 flex flex-col flex-1">
                <div
                    className="w-full rounded-xl mb-3 overflow-hidden"
                    style={{ border: `1px solid ${preview.textMuted}20`, background: preview.background }}
                >
                    <div className="flex items-center gap-1.5 px-2 h-5 shrink-0" style={{ background: preview.surface, borderBottom: `1px solid ${preview.textMuted}18` }}>
                        <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: `${preview.accent}28` }}>
                            <div className="w-1.5 h-1 rounded-sm" style={{ background: preview.accent }} />
                        </div>
                        <div className="h-1 w-8 rounded-full" style={{ background: preview.text, opacity: 0.4 }} />
                        <div className="ml-auto h-4 w-16 rounded flex items-center px-1 gap-1" style={{ background: preview.background, border: `1px solid ${preview.textMuted}20` }}>
                            <div className="h-1 flex-1 rounded-full" style={{ background: preview.textMuted, opacity: 0.15 }} />
                        </div>
                    </div>
                    <div className="flex justify-center py-1" style={{ background: preview.background }}>
                        <div className="inline-flex items-center gap-px px-1 h-4 rounded-xl" style={{ background: preview.surface, border: `1px solid ${preview.textMuted}14` }}>
                            {[
                                { w: 20, active: true },
                                { w: 16, active: false },
                                { w: 14, active: false },
                                { w: 18, active: false },
                                { w: 15, active: false },
                                { w: 14, active: false },
                            ].map(({ w, active }, i) => (
                                <div key={i} className="flex items-center px-1.5 h-3 rounded-lg" style={{
                                    background: active ? `${preview.accent}18` : 'transparent',
                                    border: active ? `1px solid ${preview.accent}28` : '1px solid transparent',
                                }}>
                                    <div className="rounded-full" style={{ width: w, height: 3, background: active ? preview.accent : preview.textMuted, opacity: active ? 0.75 : 0.28 }} />
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="px-2 pb-2 space-y-0.5">
                        {[
                            { active: true },
                            { active: false },
                            { active: false },
                        ].map((row, i) => (
                            <div key={i} className="flex items-center gap-1.5 px-1.5 py-1 rounded-lg" style={{
                                background: row.active ? `${preview.accent}08` : preview.surface,
                                border: `1px solid ${row.active ? preview.accent + '1a' : preview.textMuted + '12'}`,
                            }}>
                                <div className="w-4 h-4 rounded-lg shrink-0" style={{
                                    background: row.active ? `${preview.accent}22` : `${preview.textMuted}12`,
                                }} />
                                <div className="flex-1 min-w-0">
                                    <div className="h-1 rounded-full mb-0.5" style={{ width: `${[55, 40, 48][i]}%`, background: preview.text, opacity: 0.6 }} />
                                    <div className="rounded-full" style={{ width: `${[30, 22, 26][i]}%`, height: 2, background: preview.textMuted, opacity: 0.28 }} />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="flex items-center gap-2 min-w-0">
                        <span className="text-lg shrink-0">{option.emoji}</span>
                        <span className="font-semibold text-sm truncate" style={{ color: preview.text }}>
                            {option.label}
                        </span>
                </div>
                <p
                    className={`text-xs mt-1 line-clamp-2 ${option.italic ? 'italic' : ''}`}
                    style={{ color: preview.textMuted }}
                >
                    {option.description}
                </p>
                <div className="mt-auto flex flex-col items-stretch gap-2 pt-3 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
                    {selected ? (
                        <span
                            className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-bold"
                            style={{ background: preview.accent, color: isLightAccent ? '#000' : '#fff' }}
                        >
                            <Check className="w-3 h-3" />
                            Active
                        </span>
                    ) : (
                        <span
                            className="inline-flex h-7 items-center rounded-lg border px-2 text-xs font-bold"
                            style={actionStyle}
                        >
                            {isCustom ? 'Custom' : isSpecialTheme(option) ? 'Special' : 'Preset'}
                        </span>
                    )}
                    <div className="flex flex-wrap justify-start gap-1 min-[420px]:justify-end">
                        {!isCustom && onClone && (
                            <button
                                type="button"
                                aria-label={`Clone ${option.label} as custom theme`}
                                onClick={e => { e.stopPropagation(); onClone() }}
                                onKeyDown={e => e.stopPropagation()}
                                className="inline-flex h-7 items-center justify-center gap-1 rounded-lg border px-2 text-xs font-bold transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                style={actionStyle}
                            >
                                <Layers className="w-3 h-3" />
                                Clone
                            </button>
                        )}
                        {isCustom && onEdit && (
                            <button
                                type="button"
                                aria-label={`Edit ${option.label} theme`}
                                onClick={e => { e.stopPropagation(); onEdit() }}
                                onKeyDown={e => e.stopPropagation()}
                                className="inline-flex h-7 items-center justify-center gap-1 rounded-lg border px-2 text-xs font-bold transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                style={actionStyle}
                            >
                                <Pencil className="w-3 h-3" />
                                Edit
                            </button>
                        )}
                        {isCustom && onCopy && (
                            <button
                                type="button"
                                aria-label={`Copy ${option.label} theme JSON`}
                                onClick={e => { e.stopPropagation(); onCopy() }}
                                onKeyDown={e => e.stopPropagation()}
                                className="inline-flex h-7 items-center justify-center gap-1 rounded-lg border px-2 text-xs font-bold transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                style={actionStyle}
                            >
                                <Copy className="w-3 h-3" />
                                Copy
                            </button>
                        )}
                        {isCustom && onDownload && (
                            <button
                                type="button"
                                aria-label={`Download ${option.label} theme JSON`}
                                onClick={e => { e.stopPropagation(); onDownload() }}
                                onKeyDown={e => e.stopPropagation()}
                                className="inline-flex h-7 items-center justify-center gap-1 rounded-lg border px-2 text-xs font-bold transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                style={actionStyle}
                            >
                                <Download className="w-3 h-3" />
                                File
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}

interface ThemeSectionProps {
    theme: Theme
    setTheme: (theme: Theme) => void
}

const PRESET_PAGE_SIZE = 5
const PRESET_PAGE_STEP = 10

type ThemeFilter = 'all' | 'special' | 'light' | 'dark' | 'oled' | 'community' | 'custom'

const isSpecialTheme = (option: ThemeOption) => option.category === 'standard' && Boolean(option.customCss?.trim())

const THEME_FILTERS: { id: ThemeFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'special', label: 'Special' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'oled', label: 'OLED' },
    { id: 'community', label: 'Community' },
    { id: 'custom', label: 'Custom' },
]

const PRESET_SECTIONS: { key: ThemeFilter; heading: string; description?: string; moreLabel: string; match: (option: ThemeOption) => boolean }[] = [
    { key: 'special', heading: 'Special Themes', description: 'Distinctive shapes, textures and animations. Clone a theme to make it your own.', moreLabel: 'Special', match: isSpecialTheme },
    { key: 'light', heading: 'Light', moreLabel: 'Light', match: o => o.category === 'standard' && !isSpecialTheme(o) && o.subcategory === 'light' },
    { key: 'dark', heading: 'Dark', moreLabel: 'Dark', match: o => o.category === 'standard' && !isSpecialTheme(o) && o.subcategory === 'dark' },
    { key: 'oled', heading: 'OLED / High Contrast', moreLabel: 'OLED', match: o => o.category === 'standard' && !isSpecialTheme(o) && o.subcategory === 'oled' },
    { key: 'community', heading: 'Community', moreLabel: 'Community', match: o => o.category === 'community' },
]

export function ThemeSection({ theme, setTheme }: ThemeSectionProps) {
    const { customThemes, addCustomTheme, getAllThemeOptions } = useTheme()
    const navigate = useNavigate()
    const fileInputRef = useRef<HTMLInputElement>(null)
    const { toast } = useToast()
    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState<ThemeFilter>('all')
    const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})

    const allOptions = getAllThemeOptions()
    const customOptions = allOptions.filter(opt => typeof opt.id === 'string' && opt.id.startsWith('custom-'))
    const currentOption = allOptions.find(option => option.id === theme)

    const words = normalizeCommandText(query).split(' ').filter(Boolean)
    const searchActive = words.length > 0
    const filtersActive = searchActive || filter !== 'all'

    const matchesQuery = (option: ThemeOption) => {
        if (!searchActive) return true
        const isCustom = typeof option.id === 'string' && option.id.startsWith('custom-')
        const haystack = normalizeCommandText(
            [option.label, option.description, option.category, option.subcategory, isCustom ? 'custom' : '', isSpecialTheme(option) && !isCustom ? 'special' : ''].filter(Boolean).join(' ')
        )
        return words.every(word => haystack.includes(word))
    }

    const matchesFilter = (option: ThemeOption) => {
        if (filter === 'all') return true
        if (filter === 'special') return isSpecialTheme(option)
        if (filter === 'community') return option.category === 'community'
        if (filter === 'custom') return false
        return option.category === 'standard' && option.subcategory === filter
    }

    const presetSections = PRESET_SECTIONS.map(section => {
        const inCategory = THEME_OPTIONS.filter(section.match)
        const matching = inCategory.filter(matchesFilter).filter(matchesQuery)
        const visible = searchActive ? matching : matching.slice(0, visibleCounts[section.key] ?? PRESET_PAGE_SIZE)
        return { ...section, total: matching.length, matching, visible, shown: matching.length > 0 }
    })
    const filteredCustomOptions = customOptions.filter(() => filter === 'all' || filter === 'custom').filter(matchesQuery)
    const anyResults = presetSections.some(section => section.shown && section.matching.length > 0) || filteredCustomOptions.length > 0
    const totalMatching = presetSections.reduce((sum, section) => sum + (section.shown ? section.matching.length : 0), 0) + filteredCustomOptions.length
    const totalThemes = THEME_OPTIONS.length + customOptions.length

    const resetPagination = () => setVisibleCounts({})
    const resetFilters = () => { setQuery(''); setFilter('all'); setVisibleCounts({}) }
    const showMore = (key: string) => setVisibleCounts(counts => ({ ...counts, [key]: (counts[key] ?? PRESET_PAGE_SIZE) + PRESET_PAGE_STEP }))

    const handleEdit = (ct: CustomThemeData) => {
        navigate('/settings/theme/editor', { state: { editingTheme: ct } })
    }

    const handleOpenCreate = () => {
        navigate('/settings/theme/editor')
    }

    const handleClone = (option: ThemeOption) => {
        const bgParts = option.palette.background.split(' ').map(v => parseFloat(v))
        const bgL = bgParts[2] ?? 10
        const primary = option.palette.primary.split(' ').map(v => parseFloat(v))
        // Use background hue as the base hue (the formula derives background from hue directly)
        const bgHue = bgParts[0] ?? primary[0] ?? 220
        const seed: CustomThemeData = {
            id: createCustomThemeId(),
            label: `${option.label} (Custom)`,
            description: option.description,
            emoji: option.emoji,
            base: customThemes.find(ct => ct.id === option.id)?.base ?? option.subcategory ?? (bgL === 0 ? 'oled' : bgL < 50 ? 'dark' : 'light'),
            hue: Math.round(bgHue),
            saturation: Math.round(primary[1] ?? 70),
            palette: option.palette as unknown as ThemePalette,
            customCss: option.customCss,
            logoUrl: option.logoUrl,
        }
        navigate('/settings/theme/editor', { state: { editingTheme: seed } })
    }


    const importFromJson = (json: string) => {
        try {
            const data = JSON.parse(json)
            if (!validatePayload(data)) {
                toast({ variant: 'destructive', title: 'Invalid Theme', description: 'The JSON does not match the expected theme format.' })
                return
            }
            const themeData = payloadToThemeData(data)
            addCustomTheme(themeData)
            setTheme(themeData.id)
            resetFilters()
            toast({ title: 'Theme Imported', description: `"${data.theme.name}" has been added to your custom themes.` })
        } catch {
            toast({ variant: 'destructive', title: 'Import Failed', description: 'Could not parse the provided JSON.' })
        }
    }

    const handleImportPaste = async () => {
        try {
            const text = await navigator.clipboard.readText()
            if (!text.trim()) {
                toast({ variant: 'destructive', title: 'Clipboard Empty', description: 'Copy a theme JSON to your clipboard first.' })
                return
            }
            importFromJson(text)
        } catch {
            toast({ variant: 'destructive', title: 'Clipboard Access Denied', description: 'Allow clipboard access or use file import.' })
        }
    }

    const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
            if (typeof reader.result === 'string') {
                importFromJson(reader.result)
            }
        }
        reader.readAsText(file)
        e.target.value = ''
    }

    const handleExportCopy = (ct: CustomThemeData) => {
        const payload = themeToPayload(ct)
        navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
        toast({ title: 'Copied to Clipboard', description: `Theme "${ct.label}" JSON is ready to share.` })
    }

    const handleExportFile = (ct: CustomThemeData) => {
        const payload = themeToPayload(ct)
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${ct.label.toLowerCase().replace(/\s+/g, '-')}-aio-theme.json`
        a.click()
        URL.revokeObjectURL(url)
        toast({ title: 'Downloaded', description: `Saved "${ct.label}" theme as JSON` })
    }

    return (
        <div data-theme-part="panel" className="p-5 rounded-2xl border border-border/40 bg-card shadow-sm space-y-6">
            {/* Selected theme shown as the group's value row (owner pick 2026-11-05); the grid below stays. */}
            <div className="flex min-h-[36px] items-center gap-3 border-b border-border/30 pb-4">
                <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/35 text-muted-foreground">
                    <Palette className="h-[15px] w-[15px]" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">Theme</span>
                <span className="max-w-[40%] truncate text-xs text-muted-foreground">{currentOption?.label ?? theme}</span>
            </div>

            <div className="space-y-1">
                <h3 className="text-xs font-medium text-foreground/60">Appearance</h3>
                {currentOption && (
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span className="text-xs text-muted-foreground">Current theme</span>
                        <span className="min-w-0 truncate text-sm font-semibold">{currentOption.emoji} {currentOption.label}</span>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 bg-muted/45 px-1.5 py-1" aria-hidden="true">
                            {[currentOption.preview.background, currentOption.preview.surface, currentOption.preview.accent].map((color, i) => (
                                <span key={i} className="h-3 w-3 rounded-full border border-foreground/25" style={{ background: color }} />
                            ))}
                        </span>
                    </div>
                )}
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative w-full sm:w-64">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <Input
                        aria-label="Search themes"
                        placeholder="Search themes"
                        value={query}
                        onChange={event => { setQuery(event.target.value); resetPagination() }}
                        className="h-9 pl-9 pr-9 text-xs"
                    />
                    {query && (
                        <button
                            type="button"
                            data-theme-part="button"
                            aria-label="Clear theme search"
                            onClick={() => { setQuery(''); resetPagination() }}
                            className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Theme category">
                    {THEME_FILTERS.map(category => (
                        <button
                            key={category.id}
                            type="button"
                            data-theme-part="tab"
                            data-state={filter === category.id ? 'active' : 'inactive'}
                            aria-pressed={filter === category.id}
                            onClick={() => { setFilter(category.id); resetPagination() }}
                            className={cn(
                                'rounded-full px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                filter === category.id
                                    ? 'bg-primary/12 font-medium text-primary'
                                    : 'text-muted-foreground hover:bg-muted/30 hover:text-foreground'
                            )}
                        >
                            {category.label}
                        </button>
                    ))}
                    {filtersActive && (
                        <button
                            type="button"
                            data-theme-part="button"
                            onClick={resetFilters}
                            className="ml-1 rounded-full px-2 py-1 text-xs text-primary underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            Clear filters
                        </button>
                    )}
                </div>
            </div>

            {filtersActive && (
                <p className="-mt-3 text-xs text-muted-foreground/70" role="status" aria-live="polite">
                    {totalMatching} of {totalThemes} theme{totalThemes !== 1 ? 's' : ''} match{totalMatching !== 1 ? '' : 'es'}
                </p>
            )}

            {filtersActive && !anyResults && (
                <div className="-mt-3 flex flex-col items-center gap-2 py-4 text-center">
                    <p className="text-sm text-muted-foreground">No themes match the current search or filter.</p>
                </div>
            )}

            <div className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <h3 className="text-xs font-medium text-foreground/60">Custom themes</h3>
                    <div className="grid w-full grid-cols-3 gap-2 sm:w-auto sm:flex sm:items-center">

                        <Tooltip content="Paste theme JSON from clipboard" side="top">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleImportPaste}
                            className="w-full gap-1.5 text-xs font-medium sm:w-auto"
                        >
                            <Import className="w-3.5 h-3.5" />
                            Paste
                        </Button>
                        </Tooltip>
                        <Tooltip content="Import theme JSON file" side="top">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => fileInputRef.current?.click()}
                            className="w-full gap-1.5 text-xs font-medium sm:w-auto"
                        >
                            <Upload className="w-3.5 h-3.5" />
                            File
                        </Button>
                        </Tooltip>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".json,.aiotheme.json"
                            onChange={handleImportFile}
                            className="hidden"
                        />

                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleOpenCreate}
                            className="w-full gap-1.5 text-xs font-medium sm:w-auto"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            Create
                        </Button>
                    </div>
                </div>

                {customOptions.length > 0 ? (
                    filteredCustomOptions.length > 0 ? (
                        <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                            {filteredCustomOptions.map(option => {
                                const ctData = customThemes.find(ct => ct.id === option.id)
                                return (
                                    <ThemeCard
                                        key={option.id}
                                        option={option}
                                        selected={theme === option.id}
                                        onSelect={setTheme}
                                        onEdit={ctData ? () => handleEdit(ctData) : undefined}
                                        onCopy={ctData ? () => handleExportCopy(ctData) : undefined}
                                        onDownload={ctData ? () => handleExportFile(ctData) : undefined}
                                    />
                                )
                            })}
                        </div>
                    ) : (
                        <p className="text-xs text-muted-foreground py-2">No custom themes match the current search or filter.</p>
                    )
                ) : (
                    <p className="text-xs text-muted-foreground py-2">No custom themes yet. Click <strong>Create</strong> to design your own, or <strong>Paste</strong> a shared theme.</p>
                )}
            </div>


            {presetSections
                .filter(section => section.shown && (!filtersActive || section.matching.length > 0))
                .map(section => (
                    <div key={section.key} className="space-y-4">
                        <div className="flex items-center gap-3">
                            <span className="text-xs font-medium text-foreground/60">{section.heading}</span>
                            <div className="flex-1 h-px bg-border/50" />
                            <span className="text-xs text-muted-foreground/60">
                                {section.visible.length < section.total ? `${section.visible.length} of ${section.total}` : section.total} themes
                            </span>
                        </div>
                        {section.description && <p className="text-xs text-muted-foreground">{section.description}</p>}
                        <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                            {section.visible.map(option => (
                                <ThemeCard key={option.id} option={option} selected={theme === option.id} onSelect={setTheme} onClone={() => handleClone(option)} />
                            ))}
                        </div>
                        {!searchActive && section.visible.length < section.matching.length && (
                            <Button variant="ghost" size="sm" className="w-full text-xs text-primary" onClick={() => showMore(section.key)}>
                                Show more {section.moreLabel} themes ({section.matching.length - section.visible.length} remaining)
                            </Button>
                        )}
                    </div>
                ))}

        </div>
    )
}
