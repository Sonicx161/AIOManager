import { triggerSync } from '@/lib/sync-trigger'
import { createContext, useContext, useEffect, useLayoutEffect, useState, useCallback, useMemo, ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { isLightPalette, themeVariables } from '@/lib/theme-styles'
import { derivePreview } from '@/data/theme-core'
import { BUILTIN_THEME_META } from '@/data/theme-boot'
import { persistBootBackground, retireBootPaint } from '@/lib/boot-paint'

// Re-export all types so existing imports from '@/contexts/ThemeContext' keep working
export type { Theme, ThemePalette, ThemeOption, ThemePreview, CompactPalette } from '@/data/themes'

import type { Theme, ThemeOption, ThemePalette } from '@/data/themes'

// ── Lazy full theme catalog ──────────────────────────────────────────────────

type ThemesModule = typeof import('@/data/themes')

// The full catalog (labels, emoji, previews, skin CSS) lives in a lazy chunk.
// Boot only needs the active theme's palette, which comes from the generated
// boot meta; everything else pulls this module on demand.
let fullThemesPromise: Promise<ThemesModule> | null = null
let fullThemesLoaded: ThemesModule | null = null

function ensureFullThemes(): Promise<ThemesModule> {
    fullThemesPromise ??= import('@/data/themes').then((m) => { fullThemesLoaded = m; return m })
    return fullThemesPromise
}

// Boot waits for the full catalog only when the saved theme has skin CSS, so skin
// users see exactly what a non-lazy boot showed and everyone else skips the chunk.
export function preloadActiveSkinTheme(): Promise<void> {
    try {
        const saved = localStorage.getItem('aioman-theme')
        if (!saved || !BUILTIN_THEME_META.some((meta) => meta.id === saved && meta.hasSkin)) return Promise.resolve()
    } catch {
        return Promise.resolve()
    }
    return ensureFullThemes().then(() => undefined, () => undefined)
}

let bootOptionsCache: ThemeOption[] | null = null

function bootThemeOptions(): ThemeOption[] {
    bootOptionsCache ??= BUILTIN_THEME_META.map((meta) => ({
        id: meta.id,
        label: meta.id,
        description: '',
        emoji: '',
        category: 'standard' as const,
        palette: meta.palette,
        preview: derivePreview(meta.palette),
        ...(meta.logoUrl ? { logoUrl: meta.logoUrl } : {}),
    }))
    return bootOptionsCache
}

// ── Theme Application ────────────────────────────────────────────────────────

function applyTheme(palette: ThemePalette) {
    const root = document.documentElement
    for (const [key, value] of Object.entries(themeVariables(palette))) {
        root.style.setProperty(key, value)
    }
    // Glass surfaces swap rim and tint tokens between light and dark palettes;
    // the hairline chrome tokens read the same marker.
    root.classList.toggle('theme-light', isLightPalette(palette))
}

function applyThemeOption(option: ThemeOption) {
    applyTheme(option.palette)
    document.documentElement.setAttribute('data-theme', option.id)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', option.preview.background)
    retireBootPaint()
    persistBootBackground(option.preview.background)
    const existingStyle = document.getElementById('aioman-custom-theme-css')
    const css = option.customCss?.trim()
    if (!css) {
        existingStyle?.remove()
        return
    }
    const style = existingStyle ?? document.createElement('style')
    style.id = 'aioman-custom-theme-css'
    style.textContent = css
    if (!existingStyle) document.head.appendChild(style)
}

// ── Custom Theme Storage ─────────────────────────────────────────────────────

const CUSTOM_THEMES_KEY = 'aio-custom-themes'

export interface CustomThemeData {
    id: Theme
    label: string
    description?: string
    emoji: string
    base: 'dark' | 'light' | 'oled'
    hue: number
    saturation: number
    palette: ThemePalette
    customCss?: string
    logoUrl?: string
}

function loadCustomThemes(): CustomThemeData[] {
    try {
        const raw = localStorage.getItem(CUSTOM_THEMES_KEY)
        return raw ? JSON.parse(raw) : []
    } catch {
        return []
    }
}

function saveCustomThemes(themes: CustomThemeData[]) {
    try {
        localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes))
    } catch {
        // Storage unavailable (e.g. Safari private mode)
    }
}

function customToOption(ct: CustomThemeData): ThemeOption {
    return {
        id: ct.id,
        label: ct.label,
        description: ct.description || `Custom ${ct.base} theme`,
        emoji: ct.emoji,
        category: 'standard' as const,
        palette: ct.palette,
        preview: derivePreview(ct.palette),
        customCss: ct.customCss,
        logoUrl: ct.logoUrl,
    }
}

// ── Context ──────────────────────────────────────────────────────────────────

interface ThemeContextType {
    theme: Theme
    setTheme: (theme: Theme) => void
    customThemes: CustomThemeData[]
    addCustomTheme: (data: CustomThemeData) => void
    updateCustomTheme: (id: Theme, data: CustomThemeData) => void
    deleteCustomTheme: (id: Theme) => void
    getAllThemeOptions: () => ThemeOption[]
    isLight: boolean
    logoUrl: string | undefined
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

const STORAGE_KEY = 'aioman-theme'

// Builtin themes removed from the catalog. A saved selection matching one of
// these resolves to its fallback so the app never starts on a missing theme.
// Custom clones use `custom-*` ids and are unaffected.
const REMOVED_BUILTIN_THEMES = new Map<string, Theme>([
    ['borderlands', 'dark'],
    ['deep-orbit', 'dark'],
    ['cupertino', 'dark'],
    ['cupertino-dark', 'dark'],
])

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [customThemes, setCustomThemes] = useState<CustomThemeData[]>(loadCustomThemes)
    const [fullThemeOptions, setFullThemeOptions] = useState<ThemeOption[] | null>(() => fullThemesLoaded?.THEME_OPTIONS ?? null)

    const getAllThemeOptions = useCallback((): ThemeOption[] => {
        // Pickers and editors need the full catalog. The first call starts the
        // lazy load; state updates re-render callers with the complete list.
        void ensureFullThemes()
            .then((m) => setFullThemeOptions(m.THEME_OPTIONS))
            .catch(() => {})
        const customs = customThemes.map(customToOption)
        return fullThemeOptions ? [...fullThemeOptions, ...customs] : [...bootThemeOptions(), ...customs]
    }, [customThemes, fullThemeOptions])

    const location = useLocation()
    const isDocs = location.pathname.startsWith('/kronorium')

    const [theme, setThemeState] = useState<Theme>(() => {
        try {
            let saved = localStorage.getItem(STORAGE_KEY) as string | null
            const migrated = localStorage.getItem('aio-theme-migrated-v2')
            if (!migrated) {
                if (saved === 'midnight') { saved = 'dark' }
                if (saved) {
                    localStorage.setItem(STORAGE_KEY, saved)
                    localStorage.setItem('aio-theme-migrated-v2', '1')
                }
            }
            const migratedV3 = localStorage.getItem('aio-theme-migrated-v3')
            if (!migratedV3 && saved) {
                if (saved === 'synthwave-84') {
                    saved = 'synthwave'
                    localStorage.setItem(STORAGE_KEY, saved)
                }
                localStorage.setItem('aio-theme-migrated-v3', '1')
            }
            // Repair saved selections that point at removed builtins (e.g. an
            // old 'borderlands' pick, or one synced back from another device).
            if (saved) {
                const replacement = REMOVED_BUILTIN_THEMES.get(saved)
                if (replacement) {
                    saved = replacement
                    localStorage.setItem(STORAGE_KEY, saved)
                }
            }
            const known = (id: string) =>
                BUILTIN_THEME_META.some((meta) => meta.id === id) ||
                loadCustomThemes().some((ct) => ct.id === id)
            const match = saved ? known(saved) : false
            return (match ? saved : 'dark') as Theme
        } catch {
            return 'dark'
        }
    })

    const isLight = useMemo(() => {
        const custom = customThemes.find((ct) => ct.id === theme)
        if (custom) return isLightPalette(custom.palette)
        const meta = BUILTIN_THEME_META.find((m) => m.id === theme)
        if (!meta) return false
        return isLightPalette(meta.palette)
    }, [theme, customThemes])

    const logoUrl = useMemo(() => {
        const custom = customThemes.find((ct) => ct.id === theme)
        if (custom) return custom.logoUrl
        return BUILTIN_THEME_META.find((m) => m.id === theme)?.logoUrl
    }, [theme, customThemes])

    // Apply theme whenever it changes
    // Layout effect: the palette must be on the root before the first paint,
    // or a light theme shows the default dark surface for frames after CSS lands.
    useLayoutEffect(() => {
        if (isDocs) {
            document.getElementById('aioman-custom-theme-css')?.remove()
            // Match Kronorium's forced dark layout, including body-level portals.
            applyTheme({
                background: '0 0% 0%',
                card: '240 10% 2%',
                cardForeground: '0 0% 98%',
                primary: '45 93% 47%',
                muted: '240 5% 15%',
                mutedForeground: '240 5% 65%',
                border: '240 5% 12%',
                input: '240 5% 12%',
                ring: '45 100% 50%',
                destructive: '0 84% 60%',
            })
            document.documentElement.setAttribute('data-theme', 'dark')
            document.documentElement.classList.add('kronorium-active')
            // Kronorium is forced dark and not the user's theme: retire the boot
            // paint without persisting anything.
            retireBootPaint()
            return
        }

        // Leaving docs → aggressively clean up Fumadocs residue
        document.documentElement.classList.remove('kronorium-active')
        // Remove any data-theme set by Fumadocs RootProvider on <html>
        document.documentElement.removeAttribute('data-theme')

        const custom = customThemes.find((ct) => ct.id === theme)
        if (custom) {
            applyThemeOption(customToOption(custom))
            return
        }
        const bootOption = bootThemeOptions().find((o) => o.id === theme)
        if (bootOption) {
            // Palette applies synchronously so first paint matches the saved
            // theme; skin CSS lands via the lazy upgrade effect below.
            applyThemeOption(bootOption)
        } else {
            const existingStyleEl = document.getElementById('aioman-custom-theme-css')
            if (existingStyleEl) existingStyleEl.remove()
        }
    }, [theme, customThemes, isDocs])

    // Builtin skin CSS lives in the lazy theme chunk. Once it lands, re-apply
    // the full option so skin styling matches a non-lazy boot.
    useEffect(() => {
        if (isDocs) return
        if (customThemes.some((ct) => ct.id === theme)) return
        const meta = BUILTIN_THEME_META.find((m) => m.id === theme)
        if (!meta?.hasSkin) return
        if (fullThemeOptions) {
            const option = fullThemeOptions.find((o) => o.id === theme)
            if (option) applyThemeOption(option)
            return
        }
        let cancelled = false
        void ensureFullThemes()
            .then((m) => {
                if (cancelled) return
                setFullThemeOptions(m.THEME_OPTIONS)
                const option = m.THEME_OPTIONS.find((o) => o.id === theme)
                if (option) applyThemeOption(option)
            })
            .catch(() => {})
        return () => { cancelled = true }
    }, [theme, customThemes, isDocs, fullThemeOptions])

    // Storage event listener for cross-tab or cross-sync reactivity (fix for incognito cloud pull)
    useEffect(() => {
        const handleStorage = (e: StorageEvent | CustomEvent) => {
            const newValue = (e as StorageEvent).newValue ?? (e as CustomEvent).detail?.value
            const key = (e as StorageEvent).key ?? STORAGE_KEY
            if (key !== STORAGE_KEY || !newValue) return
            const known = (id: string) =>
                BUILTIN_THEME_META.some((meta) => meta.id === id) ||
                customThemes.some((ct) => ct.id === id)
            if (known(newValue)) {
                setThemeState(newValue as Theme)
            } else {
                const replacement = REMOVED_BUILTIN_THEMES.get(newValue)
                if (replacement) {
                    // A removed builtin arrived from another tab or device:
                    // fall back to its replacement and repair local storage.
                    // Unknown ids (custom clones not synced here yet) stay untouched.
                    setThemeState(replacement)
                    try { localStorage.setItem(STORAGE_KEY, replacement) } catch {}
                }
            }
        }
        window.addEventListener('storage', handleStorage as EventListener)
        window.addEventListener('aio-theme-change', handleStorage as EventListener)
        return () => {
            window.removeEventListener('storage', handleStorage as EventListener)
            window.removeEventListener('aio-theme-change', handleStorage as EventListener)
        }
    }, [customThemes])

    useEffect(() => {
        const handleReapply = () => {
            if (isDocs) return
            const custom = customThemes.find((ct) => ct.id === theme)
            if (custom) {
                applyThemeOption(customToOption(custom))
                return
            }
            const option = (fullThemeOptions ?? bootThemeOptions()).find((o) => o.id === theme)
            if (option) {
                applyThemeOption(option)
            } else {
                const existingStyleEl = document.getElementById('aioman-custom-theme-css')
                if (existingStyleEl) existingStyleEl.remove()
            }
        }
        window.addEventListener('aio-theme-reapply', handleReapply)
        return () => window.removeEventListener('aio-theme-reapply', handleReapply)
    }, [theme, customThemes, fullThemeOptions, isDocs])

    useEffect(() => {
        const handleCustomThemesSync = (e: CustomEvent) => {
            if (!e.detail?.themes) return
            setCustomThemes(e.detail.themes)
        }
        window.addEventListener('aio-custom-themes-change', handleCustomThemesSync as EventListener)
        return () => window.removeEventListener('aio-custom-themes-change', handleCustomThemesSync as EventListener)
    }, [])

    const setTheme = useCallback((newTheme: Theme) => {
        setThemeState(newTheme)
        try { localStorage.setItem(STORAGE_KEY, newTheme) } catch {}
        triggerSync()
    }, [])

    const addCustomTheme = useCallback((data: CustomThemeData) => {
        setCustomThemes(prev => {
            const next = [...prev, data]
            saveCustomThemes(next)
            triggerSync()
            return next
        })
    }, [])

    const updateCustomTheme = useCallback((id: Theme, data: CustomThemeData) => {
        setCustomThemes(prev => {
            const next = prev.map(t => t.id === id ? data : t)
            saveCustomThemes(next)
            triggerSync()
            return next
        })
    }, [])

    const deleteCustomTheme = useCallback((id: Theme) => {
        setCustomThemes(prev => {
            const next = prev.filter(t => t.id !== id)
            saveCustomThemes(next)
            triggerSync()
            return next
        })
        // If current theme is the deleted one, fall back
        if (theme === id) {
            setTheme('dark')
        }
    }, [theme, setTheme])

    const contextValue = useMemo(() => ({
        theme, setTheme,
        customThemes, addCustomTheme, updateCustomTheme, deleteCustomTheme,
        getAllThemeOptions, isLight, logoUrl
    }), [theme, setTheme, customThemes, addCustomTheme, updateCustomTheme, deleteCustomTheme, getAllThemeOptions, isLight, logoUrl])

    return (
        <ThemeContext.Provider value={contextValue}>
            {children}
        </ThemeContext.Provider>
    )
}

export function useTheme() {
    const context = useContext(ThemeContext)
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider')
    }
    return context
}
