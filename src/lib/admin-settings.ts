/**
 * Draft logic for the Dashboard Settings screen: unit conversion, inline
 * validation, display labels and the bottom-bar summary. Values travel as the
 * raw strings the server stores; number rows with a unit edit in that unit.
 * Relative imports for node:test.
 */
import type { SettingRow } from '../api/admin.ts'

/** A pending change: a new value in display units, a reset to default, or a new secret. */
export type SettingDraft = { kind: 'set'; value: string } | { kind: 'reset' }

export const SOURCE_LABEL = { env: 'From .env', here: 'Set here', default: 'Default', internal: 'Set by the server' } as const

const trimNumber = (n: number) => String(Math.round(n * 1000) / 1000)
const NUMBER_RE = /^\d+(?:\.\d+)?$/
const unitSuffix = (row: Pick<SettingRow, 'unit'>) => (row.unit ? ` ${row.unit.label}` : '')

/** Base unit for a display unit: ms for durations, B for sizes. */
export function baseUnitLabel(label: string): string {
    return ['h', 'min', 's', 'ms'].includes(label) ? 'ms' : ['MB', 'KB', 'B'].includes(label) ? 'B' : label
}

/** A value that is not a whole number of the display unit is shown in the base unit instead. */
export function pickSettingUnit(unit: { label: string; factor: number } | null, value: string | null): { label: string; factor: number } | null {
    if (!unit || unit.factor <= 1 || value === null || !/^\d+$/.test(value)) return unit
    return Number(value) % unit.factor === 0 ? unit : { label: baseUnitLabel(unit.label), factor: 1 }
}

export function toDisplay(row: Pick<SettingRow, 'type' | 'unit'>, raw: string | null): string {
    if (raw === null) return ''
    if (row.type === 'number' && row.unit && row.unit.factor > 1 && /^-?\d+$/.test(raw)) return trimNumber(Number(raw) / row.unit.factor)
    return raw
}

// Decimals are fine when they land on a whole base unit (1.5 s is 1500 ms).
function baseAmount(row: Pick<SettingRow, 'unit'>, v: string): number | null {
    const raw = Number(v) * (row.unit?.factor ?? 1)
    const whole = Math.round(raw)
    return Math.abs(raw - whole) < 1e-6 ? whole : null
}

export function toRaw(row: Pick<SettingRow, 'type' | 'unit'>, display: string): string {
    const v = display.trim()
    if (row.type !== 'number' || !NUMBER_RE.test(v)) return v
    const base = baseAmount(row, v)
    return base === null ? v : String(base)
}

export function displayRange(row: Pick<SettingRow, 'min' | 'max' | 'unit'>): { min: number | null; max: number | null } {
    const f = row.unit?.factor ?? 1
    return {
        min: row.min === null ? null : Math.ceil(row.min / f),
        max: row.max === null ? null : Math.floor(row.max / f),
    }
}

export function rangeHint(row: Pick<SettingRow, 'type' | 'min' | 'max' | 'unit'>): string {
    if (row.type !== 'number') return ''
    const { min, max } = displayRange(row)
    const u = unitSuffix(row)
    if (min !== null && max !== null) return `${min} to ${max}${u}`
    if (min !== null) return `min ${min}${u}`
    return ''
}

/** Same rules the server applies, in the units the operator typed. Empty means valid. */
export function draftError(row: SettingRow, draft: SettingDraft | undefined): string {
    if (!draft || draft.kind === 'reset') return ''
    const v = draft.value.trim()
    if (row.type === 'number') {
        if (!NUMBER_RE.test(v)) return row.unit ? 'Enter a number.' : 'Enter a whole number.'
        const n = baseAmount(row, v)
        if (n === null) return row.unit ? `Must be a whole number of ${baseUnitLabel(row.unit.label)}.` : 'Enter a whole number.'
        const { min, max } = displayRange(row)
        const u = unitSuffix(row)
        const low = row.min !== null && n < row.min
        const high = row.max !== null && n > row.max
        if (min !== null && max !== null && (low || high)) return `Must be between ${min} and ${max}${u}.`
        if (low) return `Must be at least ${min}${u}.`
        if (high) return `Must be at most ${max}${u}.`
        return ''
    }
    if (row.type === 'text' || row.type === 'longtext' || row.type === 'list' || row.type === 'secret') {
        if (!v) return row.type === 'secret' ? 'Enter the new value.' : 'Enter a value, or reset it to the default.'
        if (row.type === 'list' && v.split(',').map(s => s.trim()).some(s => /\s/.test(s))) return 'Entries cannot contain spaces.'
    }
    return ''
}

/** What the control shows: the draft, or the default after a reset, or the current value. */
export function shownValue(row: SettingRow, draft: SettingDraft | undefined): string {
    if (draft?.kind === 'set') return draft.value
    if (draft?.kind === 'reset') return toDisplay(row, row.defaultValue)
    return toDisplay(row, row.value)
}

export function formatSetting(row: Pick<SettingRow, 'type' | 'unit'>, raw: string | null): string {
    if (row.type === 'boolean') return raw === 'true' ? 'On' : 'Off'
    if (raw === null || raw === '') return 'Not set'
    if (row.type === 'number' && row.unit) return `${toDisplay(row, raw)} ${row.unit.label}`
    if (row.type === 'longtext' && raw.length > 60) return `${raw.slice(0, 57)}...`
    return raw
}

/** Old and new value for the save summary. Secrets never show a value. */
export function summaryValues(row: SettingRow, draft: SettingDraft): { from: string; to: string } {
    if (row.type === 'secret') return { from: row.secretSet ? 'Set' : 'Not set', to: draft.kind === 'reset' ? 'Not set' : 'Replaced' }
    const to = draft.kind === 'reset' ? row.defaultValue : toRaw(row, draft.value)
    return { from: formatSetting(row, row.value), to: draft.kind === 'reset' ? `${formatSetting(row, to)} (default)` : formatSetting(row, to) }
}

/**
 * Records an edit. Typing back the current value drops the draft, so only
 * real changes reach the bar and the server.
 */
export function nextDrafts(drafts: Record<string, SettingDraft>, row: SettingRow, draft: SettingDraft | null): Record<string, SettingDraft> {
    const next = { ...drafts }
    delete next[row.key]
    if (!draft) return next
    if (draft.kind === 'set' && row.type !== 'secret' && toRaw(row, draft.value) === (row.value ?? '')) return next
    if (draft.kind === 'reset' && row.source !== 'here') return next
    next[row.key] = draft
    return next
}

export function changesBody(rows: SettingRow[], drafts: Record<string, SettingDraft>): Record<string, string | null> {
    const out: Record<string, string | null> = {}
    for (const row of rows) {
        const d = drafts[row.key]
        if (!d) continue
        out[row.key] = d.kind === 'reset' ? null : toRaw(row, d.value)
    }
    return out
}

/** Server errors from the last save count too, including keys with no local error. */
export function barSummary(rows: SettingRow[], drafts: Record<string, SettingDraft>, serverErrors: Record<string, string> = {}): { count: number; errors: number; restart: number } {
    const edited = rows.filter(r => drafts[r.key])
    const failing = new Set([...edited.filter(r => draftError(r, drafts[r.key])).map(r => r.key), ...Object.keys(serverErrors)])
    return {
        count: edited.length,
        errors: failing.size,
        restart: edited.filter(r => r.apply === 'restart').length,
    }
}

/** Old and new value for an import diff row; null means the key goes back to its default. */
export function importDiffValues(row: SettingRow | undefined, change: { from: string | null; to: string | null }): { from: string; to: string } {
    const show = (raw: string | null) => (raw === null ? 'Default' : row ? formatSetting(row, raw) : raw)
    return { from: show(change.from), to: show(change.to) }
}

export function matchesSetting(row: SettingRow, query: string): boolean {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return `${row.label} ${row.key} ${row.summary} ${row.more}`.toLowerCase().includes(q)
}
