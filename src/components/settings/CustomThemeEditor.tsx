import { useState, useMemo, useCallback, useRef, useEffect, memo, useDeferredValue, useReducer } from 'react'
import {
    Sun, Moon, Monitor, ArrowLeft,
    Trash2, Sparkles, Smile, Search, RotateCcw, Undo2, Redo2, Copy, Check,
    Upload
} from 'lucide-react'
import { Theme, CompactPalette, ThemePalette, ThemeOption } from '@/data/themes'
import { expand, hslToHex } from '@/data/themes'
import { ThemeLivePreview } from './ThemeLivePreview'
import { createCustomThemeId, parseThemePalette } from '@/lib/theme-utils'
import { EMOJI_GROUPS } from '@/lib/emoji-data'
import { ColorPicker } from '@/components/ui/color-picker'
import { Input } from '@/components/ui/input'
import { ImageUploadButton } from '@/components/ui/image-upload-button'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import type { CustomThemeData } from '@/contexts/ThemeContext'
import { useTheme } from '@/contexts/ThemeContext'
import { cn } from '@/lib/utils'

function parseHsl(hsl: string): { h: number; s: number; l: number } {
    const parts = hsl.split(' ').map(v => parseFloat(v))
    return { h: parts[0] || 0, s: parts[1] || 0, l: parts[2] || 0 }
}

function formatHsl(h: number, s: number, l: number): string {
    return `${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%`
}

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
    const match = hex.match(/^#?([0-9a-f]{6})$/i)
    if (!match) return null
    const r = parseInt(match[1].slice(0, 2), 16) / 255
    const g = parseInt(match[1].slice(2, 4), 16) / 255
    const b = parseInt(match[1].slice(4, 6), 16) / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const l = (max + min) / 2
    if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) }
    const d = max - min
    const s = l > 0.5 ? d / (2 - max - min) : d / (max - min)
    let h = 0
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

function hslToLuminance(hsl: string): number {
    const { h, s, l } = parseHsl(hsl)
    const sl = s / 100, ll = l / 100
    const a = sl * Math.min(ll, 1 - ll)
    const f = (n: number) => {
        const k = (n + h / 30) % 12
        const c = ll - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(0) + 0.7152 * f(8) + 0.0722 * f(4)
}

function contrastRatio(hsl1: string, hsl2: string): number {
    const l1 = hslToLuminance(hsl1), l2 = hslToLuminance(hsl2)
    const lighter = Math.max(l1, l2), darker = Math.min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------



const MAX_UNDO = 30


const TOKEN_GROUPS = [
    {
        label: 'Surfaces',
        tokens: [
            { key: 'background',      label: 'Background' },
            { key: 'card',            label: 'Panel' },
            { key: 'muted',           label: 'Surface' },
        ],
    },
    {
        label: 'Text',
        tokens: [
            { key: 'cardForeground',  label: 'Body Text' },
            { key: 'mutedForeground', label: 'Muted Text' },
        ],
    },
    {
        label: 'Color',
        tokens: [
            { key: 'primary',         label: 'Accent' },
            { key: 'destructive',     label: 'Error' },
        ],
    },
    {
        label: 'Chrome',
        tokens: [
            { key: 'border',          label: 'Border' },
        ],
    },
] as const

interface EditorState {
    hue: number
    saturation: number
    bgTint: number
    bgLightness: number
    cardLightness: number
    borderLightness: number
    primaryLightness: number
    textLightness: number
    mutedLightness: number
    destructiveHue: number
    rawPalette: Record<string, string> | null
    customCss: string
}

type EditorAction =
    | { type: 'SET'; key: keyof EditorState; value: EditorState[keyof EditorState] }
    | { type: 'BATCH'; values: Partial<EditorState> }

function editorReducer(state: EditorState, action: EditorAction): EditorState {
    switch (action.type) {
        case 'SET':   return { ...state, [action.key]: action.value }
        case 'BATCH': return { ...state, ...action.values }
        default:      return state
    }
}

function detectBgTint(palette: ThemePalette): number {
    const bgS = parseHsl(palette.background).s
    const primaryS = parseHsl(palette.primary).s
    if (primaryS <= 5) return 1
    const ratio = bgS / (primaryS * 0.35)
    if (ratio < 0.15) return 0
    if (ratio < 0.65) return 0.4
    return 1
}

function makeDefaultState(t?: CustomThemeData | null): EditorState {
    if (t) return {
        hue: t.hue ?? 220,
        saturation: t.saturation ?? 70,
        bgTint: detectBgTint(t.palette),
        bgLightness: parseHsl(t.palette.background).l,
        cardLightness: parseHsl(t.palette.card).l,
        borderLightness: parseHsl(t.palette.border).l,
        primaryLightness: parseHsl(t.palette.primary).l,
        textLightness: parseHsl(t.palette.cardForeground).l,
        mutedLightness: parseHsl(t.palette.mutedForeground).l,
        destructiveHue: parseHsl(t.palette.destructive).h,
        rawPalette: t.palette as unknown as Record<string, string>,
        customCss: t.customCss ?? '',
    }
    return {
        hue: 220, saturation: 70, bgTint: 0.4,
        bgLightness: 9, cardLightness: 16, borderLightness: 22,
        primaryLightness: 60, textLightness: 98, mutedLightness: 55,
        destructiveHue: 0, rawPalette: null, customCss: '',
    }
}

const TokenColorRow = memo(function TokenColorRow({ label, hexValue, onChange }: { label: string; hexValue: string; onChange: (hex: string) => void }) {
    const [open, setOpen] = useState(false)
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    data-theme-part="button"
                    className="flex items-center gap-3 w-full text-left px-3 py-2 rounded-xl bg-muted/10 border border-border/20 hover:border-primary/30 hover:bg-muted/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring group"
                >
                    <div className="w-6 h-6 rounded-lg ring-1 ring-black/5 shadow-sm shrink-0 group-hover:scale-110 transition-transform" style={{ background: hexValue }} />
                    <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-foreground leading-tight">{label}</div>
                        <div className="text-xs font-mono text-muted-foreground/60">{hexValue}</div>
                    </div>
                </button>
            </PopoverTrigger>
            <PopoverContent className="w-[240px] p-4" align="start">
                <ColorPicker value={hexValue} onChange={(hex) => { onChangeRef.current(hex) }} />
            </PopoverContent>
        </Popover>
    )
})

interface CustomThemeEditorProps {
    editingTheme?: CustomThemeData | null
    onClose: () => void
}

export function CustomThemeEditor({ editingTheme, onClose }: CustomThemeEditorProps) {
    const { getAllThemeOptions, customThemes, addCustomTheme, updateCustomTheme, deleteCustomTheme, setTheme, isLight } = useTheme()

    const [name, setName] = useState(editingTheme?.label || '')
    const [description, setDescription] = useState(editingTheme?.description || '')
    const [emoji, setEmoji] = useState(editingTheme?.emoji || '🎨')
    const [logoUrl, setLogoUrl] = useState(editingTheme?.logoUrl || '')
    const [emojiSearch, setEmojiSearch] = useState('')
    const [base, setBase] = useState<'dark' | 'light' | 'oled'>(editingTheme?.base || 'dark')
    const [activeTab, setActiveTab] = useState<'edit' | 'import' | 'css'>('edit')
    const [rawPaletteText, setRawPaletteText] = useState('')
    const [rawPaletteError, setRawPaletteError] = useState('')
    const [fxDuration, setFxDuration] = useState('7')
    const [fxDensity, setFxDensity] = useState('170')
    const [fxDepth, setFxDepth] = useState('16')

    const [editorState, dispatch] = useReducer(editorReducer, makeDefaultState(editingTheme))

    // Stable ref mirror so pushUndo never has stale closure
    const editorStateRef = useRef(editorState)
    useEffect(() => { editorStateRef.current = editorState }, [editorState])

    const undoStackRef = useRef<EditorState[]>([])
    const [undoCount, setUndoCount] = useState(0)
    const redoStackRef = useRef<EditorState[]>([])
    const [redoCount, setRedoCount] = useState(0)

    const pushUndo = useCallback(() => {
        undoStackRef.current = [...undoStackRef.current, editorStateRef.current].slice(-MAX_UNDO)
        setUndoCount(undoStackRef.current.length)
        redoStackRef.current = []
        setRedoCount(0)
    }, [])

    const handleUndo = useCallback(() => {
        const stack = undoStackRef.current
        if (stack.length === 0) return
        const restored = stack[stack.length - 1]
        undoStackRef.current = stack.slice(0, -1)
        setUndoCount(undoStackRef.current.length)
        redoStackRef.current = [...redoStackRef.current, editorStateRef.current].slice(-MAX_UNDO)
        setRedoCount(redoStackRef.current.length)
        dispatch({ type: 'BATCH', values: restored })
    }, [])

    const handleRedo = useCallback(() => {
        const stack = redoStackRef.current
        if (stack.length === 0) return
        const restored = stack[stack.length - 1]
        redoStackRef.current = stack.slice(0, -1)
        setRedoCount(redoStackRef.current.length)
        undoStackRef.current = [...undoStackRef.current, editorStateRef.current].slice(-MAX_UNDO)
        setUndoCount(undoStackRef.current.length)
        dispatch({ type: 'BATCH', values: restored })
    }, [])

    const batchWithUndo = useCallback((values: Partial<EditorState>) => {
        pushUndo()
        dispatch({ type: 'BATCH', values })
    }, [pushUndo])

    useEffect(() => {
        setName(editingTheme?.label || '')
        setLogoUrl(editingTheme?.logoUrl || '')
        setDescription(editingTheme?.description || '')
        setEmoji(editingTheme?.emoji || '🎨')
        setBase(editingTheme?.base || 'dark')
        setRawPaletteText('')
        setRawPaletteError('')
        setActiveTab('edit')
        undoStackRef.current = []
        setUndoCount(0)
        redoStackRef.current = []
        setRedoCount(0)
        prevBaseRef.current = editingTheme?.base || 'dark'
        dispatch({ type: 'BATCH', values: makeDefaultState(editingTheme) })
    }, [editingTheme])

    const prevBaseRef = useRef(base)
    useEffect(() => {
        if (prevBaseRef.current === base) return
        prevBaseRef.current = base
        batchWithUndo(base === 'oled' ? {
            bgLightness: 0, cardLightness: 8, borderLightness: 14,
            primaryLightness: 60, textLightness: 98, mutedLightness: 45,
            rawPalette: null,
        } : base === 'dark' ? {
            bgLightness: 9, cardLightness: 16, borderLightness: 22,
            primaryLightness: 60, textLightness: 98, mutedLightness: 55,
            rawPalette: null,
        } : {
            bgLightness: 96, cardLightness: 100, borderLightness: 85,
            primaryLightness: 45, textLightness: 15, mutedLightness: 40,
            rawPalette: null,
        })
    }, [base, batchWithUndo])

    const presetOptions = useMemo(() => {
        return getAllThemeOptions().filter(opt => !opt.id.toString().startsWith('custom-'))
    }, [getAllThemeOptions])

    const applyPreset = useCallback((option: ThemeOption) => {
        const parts = option.palette.primary.split(' ').map(v => parseFloat(v))
        const lightness = parseHsl(option.palette.background).l
        const nextBase = option.subcategory ?? (lightness === 0 ? 'oled' : lightness < 50 ? 'dark' : 'light')
        prevBaseRef.current = nextBase
        setBase(nextBase)
        setEmoji(option.emoji)
        setLogoUrl(option.logoUrl ?? '')
        if (!name.trim()) setName(`${option.label} (Custom)`)
        batchWithUndo({
            hue: Math.round(parts[0] ?? 220),
            saturation: Math.round(parts[1] ?? 70),
            bgTint: detectBgTint(option.palette),
            bgLightness: parseHsl(option.palette.background).l,
            cardLightness: parseHsl(option.palette.card).l,
            borderLightness: parseHsl(option.palette.border).l,
            primaryLightness: parseHsl(option.palette.primary).l,
            textLightness: parseHsl(option.palette.cardForeground).l,
            mutedLightness: parseHsl(option.palette.mutedForeground).l,
            destructiveHue: parseHsl(option.palette.destructive).h,
            rawPalette: { ...option.palette } as Record<string, string>,
            customCss: option.customCss ?? '',
        })
    }, [batchWithUndo, name])

    const compact = useMemo((): CompactPalette => {
        const h = Math.round(editorState.hue % 360), s = Math.round(editorState.saturation)
        const t = editorState.bgTint
        return {
            background: formatHsl(h, Math.round(s * 0.35 * t), editorState.bgLightness),
            card: formatHsl(h, Math.round(s * 0.15 * t), editorState.cardLightness),
            cardForeground: formatHsl(h, Math.round(s * 0.15 * t), editorState.textLightness),
            primary: formatHsl(h, s, editorState.primaryLightness),
            muted: formatHsl(h, Math.round(s * 0.2 * t), base === 'light' ? Math.min(editorState.bgLightness, 93) : Math.max(editorState.bgLightness, base === 'oled' ? 4 : 12)),
            mutedForeground: formatHsl(h, Math.round(s * 0.15 * t), editorState.mutedLightness),
            destructive: formatHsl(editorState.destructiveHue, 75, base === 'light' ? 40 : 45),
            border: formatHsl(h, Math.round(s * 0.2 * t), editorState.borderLightness),
        }
    }, [editorState.hue, editorState.saturation, editorState.bgTint, editorState.bgLightness, editorState.cardLightness, editorState.borderLightness, editorState.primaryLightness, editorState.textLightness, editorState.mutedLightness, editorState.destructiveHue, base])

    const effectivePaletteForPreview = useMemo(() => {
        const rp = editorState.rawPalette
        if (rp && rp.background && rp.card) {
            const fallback = expand(compact)
            return {
                ...fallback,
                ...Object.fromEntries(Object.entries(rp).filter(([, v]) => v != null && v !== '')),
                input: rp.input ?? rp.border ?? fallback.input,
                ring: rp.ring ?? rp.primary ?? fallback.ring,
            }
        }
        return null
    }, [editorState.rawPalette, compact])

    const palette = useMemo(() => effectivePaletteForPreview ?? expand(compact), [effectivePaletteForPreview, compact])
    const deferredPalette = useDeferredValue(palette)
    const deferredCustomCss = useDeferredValue(editorState.customCss)

    const hexColors = useMemo(() => ({
        background:     hslToHex(palette.background),
        card:           hslToHex(palette.card),
        primary:        hslToHex(palette.primary),
        cardForeground: hslToHex(palette.cardForeground),
        mutedForeground:hslToHex(palette.mutedForeground),
        muted:          hslToHex(palette.muted),
        destructive:    hslToHex(palette.destructive),
        border:         hslToHex(palette.border),
        input:          hslToHex(palette.input),
        ring:           hslToHex(palette.ring),
    }), [palette])
    const deferredHexColors = useDeferredValue(hexColors)
    const accentHex = useMemo(() => hslToHex(palette.primary), [palette])

    const contrastPairs = useMemo(() => {
        const pairs = [
            { label: 'Body text', desc: 'on panels', fg: palette.cardForeground, bg: palette.card },
            { label: 'Buttons', desc: 'on background', fg: palette.primary, bg: palette.background },
            { label: 'Subtle text', desc: 'on panels', fg: palette.mutedForeground, bg: palette.card },
        ]
        return pairs.map(p => {
            const ratio = contrastRatio(p.fg, p.bg)
            const rounded = Math.round(ratio * 10) / 10
            const status = ratio >= 7 ? 'pass' as const : ratio >= 4.5 ? 'warn' as const : 'fail' as const
            const word = ratio >= 7 ? 'Great' : ratio >= 4.5 ? 'OK' : 'Poor'
            return {
                label: p.label, desc: p.desc, rounded, status, word,
                chipFg: `hsl(${p.fg})`, chipBg: `hsl(${p.bg})`, chipBorder: `hsl(${p.fg} / 0.15)`,
            }
        })
    }, [palette.cardForeground, palette.card, palette.primary, palette.background, palette.mutedForeground])

    // Token color change (Colors tab) - hex input, no native picker
    const handleTokenColorChange = useCallback((token: string, hex: string) => {
        const hsl = hexToHsl(hex)
        if (!hsl) return
        const hslStr = formatHsl(hsl.h, hsl.s, hsl.l)
        const current = editorStateRef.current
        const currentBase = current.rawPalette ?? (palette as unknown as Record<string, string>)
        const updated: Record<string, string> = { ...currentBase, [token]: hslStr }
        if (token === 'border') updated.input = hslStr
        undoStackRef.current = [...undoStackRef.current, current].slice(-MAX_UNDO)
        setUndoCount(undoStackRef.current.length)
        dispatch({ type: 'SET', key: 'rawPalette', value: updated })
    }, [palette])

    const handleResetAdvanced = useCallback(() => {
        batchWithUndo(base === 'oled' ? {
            rawPalette: null, bgLightness: 0, cardLightness: 8, borderLightness: 14,
            primaryLightness: 60, textLightness: 98, mutedLightness: 45, destructiveHue: 0,
        } : base === 'dark' ? {
            rawPalette: null, bgLightness: 9, cardLightness: 16, borderLightness: 22,
            primaryLightness: 60, textLightness: 98, mutedLightness: 55, destructiveHue: 0,
        } : {
            rawPalette: null, bgLightness: 96, cardLightness: 100, borderLightness: 85,
            primaryLightness: 45, textLightness: 15, mutedLightness: 40, destructiveHue: 0,
        })
    }, [batchWithUndo, base])

    const applyFxKnobs = useCallback(() => {
        const entries: string[] = []
        if (fxDuration.trim()) entries.push(`--fx-duration: ${fxDuration.trim()}s`)
        if (fxDensity.trim()) entries.push(`--fx-density: ${fxDensity.trim()}px`)
        if (fxDepth.trim()) entries.push(`--fx-depth: ${fxDepth.trim()}px`)
        if (!entries.length) return
        const block = `:root { ${entries.join('; ')}; }`
        const css = editorStateRef.current.customCss
        pushUndo()
        // Upsert: refresh an existing --fx- root block in place, else prepend one.
        const existing = css.match(/:root\s*\{[^}]*--fx-[^}]*\}/)
        dispatch({ type: 'SET', key: 'customCss', value: existing ? css.replace(existing[0], block) : `${block}\n${css}` })
    }, [fxDuration, fxDensity, fxDepth, pushUndo])

    const handleRawPaletteApply = () => {
        try {
            const parsed = JSON.parse(rawPaletteText)
            const required = ['background', 'card', 'primary', 'cardForeground', 'mutedForeground', 'muted', 'destructive', 'border']
            const missing = required.filter(k => !parsed[k])
            if (missing.length > 0) { setRawPaletteError(`Missing keys: ${missing.join(', ')}`); return }
            const importedPalette = parseThemePalette(parsed)
            if (!importedPalette) { setRawPaletteError('Use HSL channel values such as 220 70% 50% for palette colors.'); return }
            batchWithUndo({
                rawPalette: importedPalette as unknown as Record<string, string>,
                bgLightness: parseHsl(importedPalette.background).l,
                cardLightness: parseHsl(importedPalette.card).l,
                borderLightness: parseHsl(importedPalette.border).l,
                primaryLightness: parseHsl(importedPalette.primary).l,
                textLightness: parseHsl(importedPalette.cardForeground).l,
                mutedLightness: parseHsl(importedPalette.mutedForeground).l,
                destructiveHue: parseHsl(importedPalette.destructive).h,
                hue: Math.round(parseHsl(importedPalette.primary).h),
                saturation: Math.round(parseHsl(importedPalette.primary).s),
                ...(typeof parsed.customCss === 'string' ? { customCss: parsed.customCss } : {}),
            })
            if (typeof parsed.logoUrl === 'string') setLogoUrl(parsed.logoUrl)
            setRawPaletteError('')
            setActiveTab('edit')
        } catch {
            setRawPaletteError('Invalid JSON')
        }
    }

    const [copiedJson, setCopiedJson] = useState(false)
    const handleCopyJson = useCallback(() => {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(palette)) { if (typeof v === 'string') out[k] = v }
        if (editorState.customCss?.trim()) out.customCss = editorState.customCss
        if (logoUrl.trim()) out.logoUrl = logoUrl.trim()
        navigator.clipboard.writeText(JSON.stringify(out, null, 2)).then(() => {
            setCopiedJson(true); setTimeout(() => setCopiedJson(false), 2000)
        }).catch(() => {})
    }, [palette, editorState.customCss, logoUrl])

    const isValid = name.trim().length > 0
    const isEditing = !!editingTheme && customThemes.some(ct => ct.id === editingTheme.id)

    const handleSave = () => {
        if (!isValid) return
        const id: Theme = isEditing ? editingTheme!.id : createCustomThemeId()
        const data: CustomThemeData = { id, label: name.trim(), description: description.trim(), emoji, base, hue: editorState.hue, saturation: editorState.saturation, palette, customCss: editorState.customCss.trim() || undefined, logoUrl: logoUrl.trim() || undefined }
        if (isEditing) {
            updateCustomTheme(id, data)
        } else {
            addCustomTheme(data)
        }
        setTheme(id)
        onClose()
    }

    const handleDelete = () => {
        if (!editingTheme) return
        deleteCustomTheme(editingTheme.id)
        onClose()
    }

    return (
        <div className="flex flex-col gap-5">

            {/* Page header: back, title, and save/delete actions span the full width */}
            <div className="flex flex-wrap items-center gap-3">
                <Tooltip content="Back to appearance settings" side="top">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onClose}
                        aria-label="Back to appearance settings"
                        className="h-9 w-9 text-muted-foreground hover:text-foreground shrink-0"
                    >
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                </Tooltip>
                <div className="min-w-0">
                    <h1 className="text-lg font-semibold leading-tight">
                        {isEditing ? 'Edit Theme' : 'Create Theme'}
                    </h1>
                    <p className="text-xs text-muted-foreground">
                        {isEditing ? `Editing "${editingTheme?.label}"` : 'Design your own colors, typography and CSS'}
                    </p>
                </div>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                    {isEditing && (
                        <Button variant="outline" size="sm" onClick={handleDelete} className="h-9 gap-1.5 text-destructive hover:text-destructive border-destructive/30 hover:bg-destructive/10">
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete</span>
                        </Button>
                    )}
                    <Button onClick={handleSave} disabled={!isValid} className="h-9 px-5 gap-1.5">
                        <Sparkles className="w-3.5 h-3.5" />
                        {isEditing ? 'Update' : 'Create'}
                    </Button>
                </div>
            </div>

            {/* Work area: controls take the wider share, preview sticks beside them */}
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,58fr)_minmax(0,42fr)] gap-5 lg:items-start">

            <div data-theme-part="card" className="@container flex flex-col w-full min-w-0 bg-card border border-border/40 rounded-2xl shadow-sm overflow-hidden">

                <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-5 py-3 border-b border-border/30">
                    <div className="flex items-center gap-1 shrink-0">
                        <Tooltip content="Undo" side="top">
                            <Button variant="ghost" size="icon" onClick={handleUndo} disabled={undoCount === 0} aria-label="Undo" className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
                                <Undo2 className="w-3.5 h-3.5" />
                            </Button>
                        </Tooltip>
                        <Tooltip content="Redo" side="top">
                            <Button variant="ghost" size="icon" onClick={handleRedo} disabled={redoCount === 0} aria-label="Redo" className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
                                <Redo2 className="w-3.5 h-3.5" />
                            </Button>
                        </Tooltip>
                    </div>
                    <div className="w-px h-4 bg-border shrink-0" />
                    {/* @ts-expect-error Radix Select secretly accepts modal false */}
                    <Select modal={false} onValueChange={(val) => {
                        const opt = presetOptions.find(o => o.id === val)
                        if (opt) applyPreset(opt)
                    }}>
                        <SelectTrigger className="h-8 text-xs bg-background/50 border-muted min-w-[170px] flex-1 sm:max-w-[240px]">
                            <SelectValue placeholder="Start from a preset..." />
                        </SelectTrigger>
                        <SelectContent className="max-h-[300px]">
                            {presetOptions.map(opt => (
                                <SelectItem key={opt.id} value={opt.id as string} className="cursor-pointer text-xs">
                                    <div className="flex items-center gap-2">
                                        <div className="w-3 h-3 rounded-full shrink-0" style={{ background: opt.preview.accent }} />
                                        <span>{opt.emoji} {opt.label}</span>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <div data-theme-part="tabs-list" className="flex gap-1 rounded-xl border border-border/40 bg-card p-1 shadow-sm ml-auto shrink-0">
                        {([
                            { id: 'edit',   label: 'Edit'   },
                            { id: 'import', label: 'JSON' },
                            { id: 'css',    label: 'CSS'   },
                        ] as const).map(({ id, label }) => (
                            <button
                                key={id}
                                data-theme-part="tab"
                                data-state={activeTab === id ? 'active' : 'inactive'}
                                onClick={() => setActiveTab(id)}
                                className={cn(
                                    "relative inline-flex items-center justify-center rounded-lg border px-3 py-1 text-xs font-medium transition-[transform,opacity,box-shadow] whitespace-nowrap",
                                    activeTab === id
                                        ? 'border-border/40 bg-background text-foreground shadow-sm'
                                        : 'border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                                )}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>

                <div>

                    {activeTab === 'edit' && (
                        <div className="divide-y divide-border/30">
                            <div className="px-5 py-4">
                                <div className="flex gap-3 items-start">
                                    <div className="flex flex-col gap-1.5 shrink-0">
                                        <span className="text-xs font-medium text-muted-foreground">Icon</span>
                                        <div className="flex items-center gap-1.5">
                                        <Input
                                            value={emoji}
                                            onChange={(e) => setEmoji(e.target.value)}
                                            placeholder="🎨"
                                            aria-label="Theme emoji"
                                            className="w-12 h-12 text-center text-2xl p-0 rounded-xl bg-background/50 border-muted shadow-inner"
                                            maxLength={4}
                                        />
                                        <Popover>
                                            <Tooltip content="Browse emojis" side="top">
                                                <PopoverTrigger asChild>
                                                    <Button type="button" variant="subtle" aria-label="Browse emojis" className="h-12 w-8 rounded-xl flex items-center justify-center group">
                                                        <Smile className="h-3.5 w-3.5 opacity-40 group-hover:opacity-80 transition-opacity" />
                                                    </Button>
                                                </PopoverTrigger>
                                            </Tooltip>
                                            <PopoverContent className="w-[min(320px,90vw)] p-0 border-white/10 shadow-2xl overflow-hidden rounded-xl" align="start">
                                                <div className="flex flex-col h-[360px] bg-popover">
                                                    <div className="p-3 border-b border-border/10 bg-muted/20">
                                                        <div className="relative">
                                                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                                            <Input placeholder="Search emojis..." className="pl-9 h-9 text-xs bg-muted/30 border border-border/40 rounded-lg"
                                                                value={emojiSearch} onChange={(e) => setEmojiSearch(e.target.value)} autoFocus />
                                                        </div>
                                                    </div>
                                                    <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                                                        {Object.entries(EMOJI_GROUPS).map(([group, emojis]) => {
                                                            const filtered = emojis.filter(e =>
                                                                e.keywords.some(k => k.toLowerCase().includes(emojiSearch.toLowerCase())) ||
                                                                e.char.includes(emojiSearch)
                                                            )
                                                            if (filtered.length === 0) return null
                                                            return (
                                                                <div key={group} className="mb-5 last:mb-0">
                                                                    <h4 className="text-xs font-semibold uppercase text-primary/60 mb-2.5 px-1">{group}</h4>
                                                                    <div className="grid grid-cols-6 gap-1.5">
                                                                        {filtered.map((e) => (
                                                                            <Tooltip key={e.char} content={e.keywords[0]}>
                                                                                <button type="button" onClick={() => setEmoji(e.char)}
                                                                                     className={`h-10 w-10 flex items-center justify-center text-xl rounded-xl transition-[transform,opacity,box-shadow] duration-200 hover:scale-110 ${emoji === e.char ? `bg-primary/25 ring-2 ${isLight ? 'ring-primary' : 'ring-primary/50'} shadow-lg scale-110` : 'hover:bg-accent/40'}`}
                                                                                >
                                                                                    {e.char}
                                                                                </button>
                                                                            </Tooltip>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            )
                                                        })}
                                                    </div>
                                                </div>
                                            </PopoverContent>
                                        </Popover>
                                        </div>
                                    </div>
                                    <div className="flex-1 min-w-0 space-y-3">
                                        <div className="space-y-1.5">
                                            <label htmlFor="custom-theme-name" className="block text-xs font-medium text-muted-foreground">Name</label>
                                            <Input
                                                id="custom-theme-name"
                                                value={name}
                                                onChange={e => setName(e.target.value)}
                                                placeholder="Theme name"
                                                maxLength={30}
                                                className="h-10 px-4 text-sm font-semibold bg-background/50 border-muted"
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label htmlFor="custom-theme-description" className="block text-xs font-medium text-muted-foreground">Description</label>
                                            <Input
                                                id="custom-theme-description"
                                                value={description}
                                                onChange={e => setDescription(e.target.value)}
                                                placeholder="Optional description shown in the theme list"
                                                className="h-8 text-xs"
                                                maxLength={80}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label htmlFor="custom-theme-logo" className="block text-xs font-medium text-muted-foreground">Header logo</label>
                                            <div className="flex gap-2">
                                                <Input
                                                    id="custom-theme-logo"
                                                    value={logoUrl.startsWith('data:') ? '\u2713 Uploaded image' : logoUrl}
                                                    onChange={e => setLogoUrl(e.target.value)}
                                                    placeholder="Logo URL shown in the app header"
                                                    className="h-8 text-xs"
                                                    readOnly={logoUrl.startsWith('data:')}
                                                />
                                                <ImageUploadButton
                                                    onUploaded={setLogoUrl}
                                                    options={{ maxDimension: 256, square: false, quality: 0.85 }}
                                                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                                                    label="Upload logo"
                                                >
                                                    <Upload className="h-3.5 w-3.5" />
                                                    <span className="sr-only">Upload logo image</span>
                                                </ImageUploadButton>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="px-5 py-4 space-y-3">
                                <p className="text-sm font-medium text-muted-foreground">Base &amp; Tint</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Base mode</p>
                                        <div className="grid grid-cols-3 gap-2">
                                            {([
                                                { mode: 'light' as const, Icon: Sun,     label: 'Light', desc: 'Bright' },
                                                { mode: 'dark'  as const, Icon: Moon,    label: 'Dark',  desc: 'Comfort' },
                                                { mode: 'oled'  as const, Icon: Monitor, label: 'OLED',  desc: 'Black' },
                                            ]).map(({ mode, Icon, label, desc }) => (
                                                <button
                                                    key={mode}
                                                    data-theme-part="tab"
                                                    data-state={base === mode ? 'active' : 'inactive'}
                                                    onClick={() => setBase(mode)}
                                                    className={cn(
                                                        'relative flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 transition-[transform,opacity,box-shadow]',
                                                        base === mode
                                                            ? 'border-border/40 bg-background text-foreground shadow-sm'
                                                            : 'border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                                                    )}
                                                >
                                                    <div className="relative z-10 flex items-center gap-1.5">
                                                        <Icon className="w-3.5 h-3.5" />
                                                        <span className="text-xs font-semibold">{label}</span>
                                                    </div>
                                                    <span className="relative z-10 text-xs text-muted-foreground">{desc}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Background tint</p>
                                        <div className="grid grid-cols-3 gap-2">
                                            {([
                                                { label: 'Neutral', value: 0,   desc: 'Pure' },
                                                { label: 'Subtle',  value: 0.4, desc: 'Slight' },
                                                { label: 'Vibrant', value: 1,   desc: 'Full' },
                                            ] as const).map(({ label, value, desc }) => (
                                                <button
                                                    key={label}
                                                    type="button"
                                                    data-theme-part="tab"
                                                    data-state={editorState.bgTint === value ? 'active' : 'inactive'}
                                                    onClick={() => batchWithUndo({ bgTint: value, rawPalette: null })}
                                                    className={cn(
                                                        'relative flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 transition-[transform,opacity,box-shadow]',
                                                        editorState.bgTint === value
                                                            ? 'border-border/40 bg-background text-foreground shadow-sm'
                                                            : 'border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                                                    )}
                                                >
                                                    <span className="relative z-10 text-xs font-semibold">{label}</span>
                                                    <span className="relative z-10 text-xs text-muted-foreground">{desc}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 @min-[600px]:grid-cols-[220px_minmax(0,1fr)] gap-6 px-5 py-4">
                                <div className="space-y-3">
                                    <p className="text-sm font-medium text-muted-foreground">Accent Color</p>
                                    <div className="max-w-[250px]">
                                        <ColorPicker
                                            value={accentHex}
                                            onChange={(hex) => {
                                                const hsl = hexToHsl(hex)
                                                if (hsl) batchWithUndo({ hue: hsl.h, saturation: hsl.s, primaryLightness: hsl.l, rawPalette: null })
                                            }}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <p className="text-sm font-medium text-muted-foreground">Fine-Tune Colors</p>
                                        <Button onClick={handleResetAdvanced} variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 h-6 px-2">
                                            <RotateCcw className="w-3 h-3" /> Reset
                                        </Button>
                                    </div>
                                    <div className="space-y-4">
                                        {TOKEN_GROUPS.map(group => (
                                            <div key={group.label} className="space-y-1.5">
                                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{group.label}</p>
                                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                                    {group.tokens.map(({ key, label }) => (
                                                        <TokenColorRow
                                                            key={key}
                                                            label={label}
                                                            hexValue={deferredHexColors[key as keyof typeof deferredHexColors] || '#000000'}
                                                            onChange={(hex) => handleTokenColorChange(key, hex)}
                                                        />
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'css' && (
                        <div className="px-5 py-5 space-y-4">
                            <div>
                                <p className="text-sm font-medium">Custom CSS</p>
                                <p className="text-xs text-muted-foreground mt-1">
                                    Style fonts, textures, controls, layout and animation. Changes appear in the live sample. Use <code>hsl(var(--primary))</code> for palette colors and <code>[data-theme-part="card"]</code> for panels. Load a preset to remix its commented CSS.
                                </p>
                            </div>
                            <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border/30 bg-muted/10 p-3">
                                <p className="w-full text-xs font-medium text-muted-foreground">
                                    FX knobs — retune themes that expose <code>--fx-duration</code> (motion speed), <code>--fx-density</code> (texture density) and <code>--fx-depth</code> (glow/shadow depth). Writes a <code>:root</code> block into the CSS below.
                                </p>
                                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                    <span>Duration (s)</span>
                                    <Input aria-label="FX duration in seconds" className="h-7 w-20 font-mono text-xs" value={fxDuration} onChange={e => setFxDuration(e.target.value)} />
                                </label>
                                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                    <span>Density (px)</span>
                                    <Input aria-label="FX density in pixels" className="h-7 w-20 font-mono text-xs" value={fxDensity} onChange={e => setFxDensity(e.target.value)} />
                                </label>
                                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                    <span>Depth (px)</span>
                                    <Input aria-label="FX depth in pixels" className="h-7 w-20 font-mono text-xs" value={fxDepth} onChange={e => setFxDepth(e.target.value)} />
                                </label>
                                <Button variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={applyFxKnobs}>Apply to CSS</Button>
                            </div>
                            <textarea
                                aria-label="Custom CSS"
                                data-theme-part="textarea"
                                className="w-full h-48 font-mono text-xs bg-background/50 border border-border/40 rounded-lg p-3 resize-y focus:outline-none focus:ring-1 focus:ring-primary/40"
                                placeholder={'/* Try a glowing addon card */\n[data-theme-part="addon-card"] {\n  border-radius: 24px;\n  box-shadow: 0 0 24px hsl(var(--primary) / .3);\n}\n\n/* Change typography across the app */\nbody { font-family: Georgia, serif; }'}
                                value={editorState.customCss}
                                onFocus={pushUndo}
                                onChange={e => dispatch({ type: 'SET', key: 'customCss', value: e.target.value })}
                            />
                            <p className="text-xs text-muted-foreground">
                                The sample is isolated from the editor. Saved CSS applies across the app while the theme is active. Target <code>app-nav</code> and <code>nav-item</code> for navigation, or <code>card</code>, <code>button</code> and other shared parts. Open More controls in the sample to simulate syncing. <a href="/kronorium/settings/appearance" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">Theme reference</a>
                            </p>
                        </div>
                    )}

                    {activeTab === 'import' && (
                        <div className="px-5 py-5 space-y-4">
                            <div className="flex items-center gap-2">
                                <p className="text-xs text-muted-foreground">Current palette as JSON. Copy to share or paste a palette to import.</p>
                                <Button onClick={handleCopyJson} variant="outline" size="sm" className="ml-auto h-7 px-3 text-xs font-bold flex items-center gap-1.5 shrink-0">
                                    {copiedJson ? <><Check className="w-3 h-3 text-success" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
                                </Button>
                            </div>
                            <pre data-theme-part="field" className="w-full h-44 font-mono text-xs bg-background/50 border border-border/40 rounded-lg p-3 overflow-auto resize-y text-foreground/80">
                                {JSON.stringify({ ...Object.fromEntries(Object.entries(palette).filter(([_k, v]) => typeof v === 'string')), ...(editorState.customCss?.trim() ? { customCss: editorState.customCss } : {}), ...(logoUrl.trim() ? { logoUrl: logoUrl.trim() } : {}) }, null, 2)}
                            </pre>
                            <div className="border-t border-border/30 pt-4 space-y-3">
                                <p className="text-xs font-medium text-muted-foreground uppercase">Import Palette</p>
                                <p className="text-xs text-muted-foreground">
                                    Paste a palette JSON with HSL values. Required: <span className="font-mono text-xs bg-muted/40 px-1 rounded-lg">background, card, primary, cardForeground, mutedForeground, muted, destructive, border</span>
                                </p>
                                <textarea
                                    data-theme-part="textarea"
                                    className="w-full h-32 font-mono text-xs bg-background/50 border border-border/40 rounded-lg p-3 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40"
                                    placeholder={'{\n  "background": "34 60% 92%",\n  "card": "34 70% 86%",\n  ...\n}'}
                                    value={rawPaletteText}
                                    onChange={e => { setRawPaletteText(e.target.value); setRawPaletteError('') }}
                                />
                                {rawPaletteError && <p className="text-xs text-destructive font-medium">{rawPaletteError}</p>}
                                <Button type="button" size="sm" onClick={handleRawPaletteApply}>Apply Palette</Button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Preview column: content-sized, sticks near the top while controls scroll */}
            <div className="hidden lg:block min-w-0 [@media(min-height:820px)]:sticky top-16">
                <div data-theme-part="card" className="rounded-2xl border border-border/40 bg-card shadow-sm overflow-hidden">
                    <div className="px-5 py-4 border-b border-border/30">
                        <div className="flex items-center gap-2">
                            <h2 className="text-sm font-semibold">Live preview</h2>
                            <span data-theme-part="badge" className="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">Sample</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">Your palette and CSS on a sample of the app.</p>
                    </div>
                    <div className="px-4 py-4 sm:px-5">
                        <ThemeLivePreview palette={deferredPalette} customCss={deferredCustomCss} logoUrl={logoUrl.trim()} />
                    </div>
                    <div className="px-5 py-4 border-t border-border/30 space-y-2.5">
                        <div className="flex items-baseline justify-between gap-2 flex-wrap">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contrast checks</p>
                            <p className="text-xs text-muted-foreground">7:1 and up is Great, 4.5:1 and up is OK</p>
                        </div>
                        {contrastPairs.map(p => (
                            <div key={p.label} className="flex items-center gap-3">
                                <div className="h-8 w-12 rounded-lg shrink-0 flex items-center justify-center border" style={{ background: p.chipBg, color: p.chipFg, borderColor: p.chipBorder }}>
                                    <span className="text-sm font-semibold">Aa</span>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <span className="text-xs font-medium text-foreground">{p.label}</span>{' '}
                                    <span className="text-xs text-muted-foreground">{p.desc}</span>
                                </div>
                                <span className="text-xs font-medium tabular-nums text-muted-foreground">{p.rounded}:1</span>
                                <span className={cn(
                                    'text-xs font-semibold w-10 text-right shrink-0',
                                    p.status === 'pass' ? 'text-green-600' : p.status === 'warn' ? 'text-amber-600' : 'text-red-600'
                                )}>{p.word}</span>
                            </div>
                        ))}
                        {editorState.customCss?.trim() && (
                            <p className="text-xs text-muted-foreground pt-2 border-t border-border/20">
                                Contrast checks measure palette colors. CSS effects can change the final appearance.
                            </p>
                        )}
                    </div>
                </div>
            </div>
            </div>

        </div>
    )
}
