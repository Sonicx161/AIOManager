import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate'
import type { ReplayData, RankedTitle, Milestone } from '@/types/ReplayTypes'

export const SHARE_CODEC_VERSION = 7
export const SHARE_FRAGMENT_SEGMENT = 'v7'

export const MILESTONE_TEMPLATES: ReadonlyArray<Omit<Milestone, 'value' | 'unlocked'>> = [
    { id: 'titles-50', icon: '🎬', title: 'Cineplex Pass', description: 'Watched 50 unique titles', threshold: 50 },
    { id: 'titles-100', icon: '🏅', title: 'Century Club', description: 'Watched 100 unique titles', threshold: 100 },
    { id: 'titles-250', icon: '🏆', title: 'Quarter Thousand', description: 'Watched 250 unique titles', threshold: 250 },
    { id: 'titles-500', icon: '👑', title: 'Half Millennium', description: 'Watched 500 unique titles', threshold: 500 },
    { id: 'hours-100', icon: '⏱️', title: 'Centurion', description: 'Streamed 100+ hours', threshold: 100 },
    { id: 'hours-500', icon: '🔥', title: 'Dedicated Viewer', description: 'Streamed 500+ hours', threshold: 500 },
    { id: 'hours-1000', icon: '💎', title: 'Legendary Status', description: 'Streamed 1,000+ hours', threshold: 1000 },
    { id: 'streak-7', icon: '📅', title: 'Week Warrior', description: 'Binge streak of 7+ days', threshold: 7 },
    { id: 'streak-14', icon: '🎯', title: 'Fortnight Force', description: 'Binge streak of 14+ days', threshold: 14 },
    { id: 'streak-30', icon: '⚡', title: 'Monthly Marathon', description: 'Binge streak of 30+ days', threshold: 30 },
    { id: 'genres-5', icon: '🔍', title: 'Genre Explorer', description: 'Watched across 5+ categories', threshold: 5 },
    { id: 'discoveries-25', icon: '🔍', title: 'Trailblazer', description: 'Discovered 25+ new titles', threshold: 25 },
]

// v6 was positional over this list minus genres-5; v6 encoders always emitted all 12.
const V5_TEMPLATES = MILESTONE_TEMPLATES.filter(t => t.id !== 'genres-5')

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i

const ttDigits = (id: string | undefined): string | null => id?.match(/^tt(\d+)$/)?.[1] ?? null
const metahubPoster = (digits: string) => `https://live.metahub.space/poster/small/tt${digits}/img`

function toBase64Url(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function fromBase64Url(token: string): Uint8Array {
    const bin = atob(token.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(bin, c => c.charCodeAt(0))
}

/** v7 carries no account name, connection id, base URL or non-IMDb item id. */
export function encodeReplayShare(data: ReplayData): string {
    const titlePool: Array<[string | null, string, number]> = []
    const titleIdx = new Map<string, number>()
    const idxOf = (t: RankedTitle | undefined | null) => {
        if (!t || !t.itemId) return -1
        const known = titleIdx.get(t.itemId)
        if (known !== undefined) return known
        const idx = titlePool.length
        titlePool.push([ttDigits(t.itemId), t.name, t.type === 'series' ? 1 : 0])
        titleIdx.set(t.itemId, idx)
        return idx
    }
    const yoy = data.yearOverYear
    const payload = [
        SHARE_CODEC_VERSION,
        data.year,
        data.totalTitles,
        Math.round(data.totalHours),
        data.totalGenres,
        data.longestStreak,
        Math.round(data.avgTitlesPerMonth),
        Math.round(data.discoveryPercentage),
        data.totalUniqueDiscoveries,
        data.persona,
        data.personaDescription,
        titlePool,
        data.topTitles.slice(0, 10).map(t => [idxOf(t), Math.round(t.totalHours), t.watchCount]),
        (data.discoveries || []).slice(0, 10).map(idxOf),
        (data.marathonTitles || []).slice(0, 10).map(idxOf),
        (data.hiddenGems || []).slice(0, 10).map(idxOf),
        data.topGenres.slice(0, 10).map(g => [g.genre, g.count, Math.round(g.percentage), g.color]),
        (data.heroPosterArt || []).slice(0, 24).map(url => url?.match(/tt(\d+)/)?.[1]).filter(Boolean),
        data.monthlyBreakdown.map(m => [
            m.totalTitles,
            Math.round(m.totalHours),
            (m.top3Titles || []).map(idxOf).filter(idx => idx !== -1),
            m.isHighActivity ? 1 : 0,
        ]),
        data.milestones.map(m => [m.id, m.unlocked ? 1 : 0, Math.round(m.value)]),
        data.hourlyDistribution.map(h => [Math.round(h.percentage), h.count]),
        data.dailyDistribution.map(d => [Math.round(d.percentage), Math.round(d.count), Math.round(d.hours)]),
        yoy ? [
            yoy.prevYear, yoy.currentYear, yoy.titlesDelta, Math.round(yoy.hoursDelta), Math.round(yoy.loyaltyDelta),
            yoy.streakDelta, yoy.prevTitles, Math.round(yoy.prevHours), yoy.currentTitles, Math.round(yoy.currentHours),
        ] : null,
        data.peakHour,
        data.peakDay,
    ]
    return toBase64Url(deflateSync(strToU8(JSON.stringify(payload)), { level: 9 }))
}

export function buildReplayShareUrl(origin: string, data: ReplayData): string {
    return `${origin}/replay/share/${SHARE_FRAGMENT_SEGMENT}#${encodeReplayShare(data)}`
}

/** Fragment links (v7) keep the token out of server logs and referrers; old path tokens still decode. */
export function shareTokenFromLocation(pathToken: string | undefined, hash: string): string | null {
    if (pathToken === SHARE_FRAGMENT_SEGMENT) return hash.replace(/^#/, '') || null
    return pathToken || null
}

/** Removes the bookmark ?id= from a share page URL; null when there is nothing to strip. */
export function stripShareIdParam(href: string): string | null {
    const url = new URL(href)
    if (!url.searchParams.has('id')) return null
    url.searchParams.delete('id')
    return url.toString()
}

export interface DecodedReplayShare {
    data: ReplayData
    userName?: string
}

type Row = unknown[]

export function decodeReplayShare(token: string): DecodedReplayShare | null {
    try {
        const json = strFromU8(inflateSync(fromBase64Url(token)))
        if (!json) return null
        const payload = JSON.parse(json)
        if (!Array.isArray(payload)) return null
        const version = payload[0]
        if (version === 7) return decodeV7(payload)
        if (version === 5 || version === 6) return decodeLegacy(payload, version === 6)
        return null
    } catch {
        return null
    }
}

// Legacy pools stored any id with a stripped tt prefix; only real IMDb digits ever reach metahub.
function buildPool(tp: unknown): RankedTitle[] {
    return ((tp || []) as Row[]).map((arr, idx) => {
        const raw = arr[0]
        const digits = typeof raw === 'string' && /^\d+$/.test(raw) ? raw : null
        const id = digits ? `tt${digits}` : `share:${idx}`
        return {
            itemId: id,
            name: String(arr[1] ?? ''),
            type: arr[2] === 1 ? 'series' : 'movie',
            poster: digits ? metahubPoster(digits) : '',
            id,
            uniqueItemId: id,
            watchCount: 0,
            totalHours: 0,
            rank: 0,
        }
    })
}

function common(pool: RankedTitle[], o: {
    y: unknown; tt: unknown; th: unknown; tg: unknown; ls: unknown; apm: unknown; dp: unknown; tud: unknown; pers: unknown; pd: unknown
    t: unknown; ds: unknown; mt: unknown; hg: unknown; g: unknown; hpa: unknown; mb: unknown; hd: unknown; dd: unknown; yoy: unknown; ph: unknown; pdb: unknown
    full: boolean
}): Omit<ReplayData, 'milestones'> {
    const y = o.y as ReplayData['year']
    const pick = (idx: unknown) => pool[idx as number]
    const yoy = o.yoy as Row | null
    return {
        year: y,
        totalTitles: o.tt as number,
        totalHours: o.th as number,
        totalGenres: o.tg as number,
        longestStreak: o.ls as number,
        avgTitlesPerMonth: o.apm as number,
        topTitles: ((o.t || []) as Row[]).map((arr, i) => {
            const base = pick(arr[0])
            return base ? { ...base, totalHours: arr[1] as number, watchCount: o.full ? arr[2] as number : 0, rank: i + 1 } : null
        }).filter((t): t is RankedTitle => !!t),
        topGenres: ((o.g || []) as Row[]).map(arr => ({
            genre: String(arr[0] ?? ''),
            count: arr[1] as number,
            percentage: arr[2] as number,
            color: typeof arr[3] === 'string' && HEX_COLOR.test(arr[3]) ? arr[3] : '#6366f1',
        })),
        monthlyBreakdown: ((o.mb || []) as Row[]).map((arr, i) => {
            const year = typeof y === 'number' ? y : Number(String(y).split('-')[0]) || new Date().getFullYear()
            const mTitles = ((arr[2] || []) as unknown[]).map((idx, r) => {
                const base = pick(idx)
                return base ? { ...base, rank: r + 1 } : null
            }).filter((t): t is RankedTitle => !!t)
            return {
                month: MONTH_NAMES[i] || 'Unknown',
                monthKey: `${year}-${String(i + 1).padStart(2, '0')}`,
                totalTitles: arr[0] as number,
                totalHours: arr[1] as number,
                topTitle: mTitles[0],
                top3Titles: mTitles,
                isHighActivity: arr[3] === 1,
            }
        }),
        discoveries: ((o.ds || []) as unknown[]).map(pick).filter(Boolean),
        marathonTitles: ((o.mt || []) as unknown[]).map(pick).filter(Boolean),
        hiddenGems: ((o.hg || []) as unknown[]).map(pick).filter(Boolean),
        availableYears: [],
        availableMonths: [],
        heroPosterArt: ((o.hpa || []) as unknown[])
            .filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id))
            .map(metahubPoster),
        persona: (o.pers as string) ?? '',
        personaDescription: (o.pd as string) ?? '',
        hourlyDistribution: ((o.hd || []) as Array<Row | number>).map((item, h) => ({
            hour: h,
            percentage: o.full ? (item as Row)[0] as number : item as number,
            count: o.full ? (item as Row)[1] as number : 0,
        })),
        dailyDistribution: ((o.dd || []) as Array<Row | number>).map((item, d) => ({
            day: d,
            dayName: DAY_NAMES[d],
            percentage: o.full ? (item as Row)[0] as number : item as number,
            count: o.full ? (item as Row)[1] as number : 0,
            hours: o.full ? (item as Row)[2] as number : 0,
        })),
        yearOverYear: yoy ? {
            prevYear: yoy[0] as number,
            currentYear: yoy[1] as number,
            titlesDelta: yoy[2] as number,
            hoursDelta: yoy[3] as number,
            loyaltyDelta: yoy[4] as number,
            streakDelta: yoy[5] as number,
            prevTitles: o.full ? yoy[6] as number : 0,
            prevHours: o.full ? yoy[7] as number : 0,
            currentTitles: o.full ? yoy[8] as number : 0,
            currentHours: o.full ? yoy[9] as number : 0,
        } : null,
        peakHour: (o.ph as number) ?? 0,
        peakDay: (o.pdb as string) ?? '',
        discoveryPercentage: (o.dp as number) ?? 0,
        totalUniqueDiscoveries: (o.tud as number) ?? 0,
    }
}

function decodeV7(p: Row): DecodedReplayShare {
    const [, y, tt, th, tg, ls, apm, dp, tud, pers, pd, tp, t, ds, mt, hg, g, hpa, mb, m, hd, dd, yoy, ph, pdb] = p
    const pool = buildPool(tp)
    const byId = new Map(((m || []) as Row[]).map(row => [String(row[0]), row]))
    const milestones = MILESTONE_TEMPLATES.map(tmpl => {
        const row = byId.get(tmpl.id)
        return { ...tmpl, unlocked: row?.[1] === 1, value: (row?.[2] as number) ?? 0 }
    })
    const rest = common(pool, { y, tt, th, tg, ls, apm, dp, tud, pers, pd, t, ds, mt, hg, g, hpa, mb, hd, dd, yoy, ph, pdb, full: true })
    return { data: { ...rest, milestones } }
}

function decodeLegacy(p: Row, isV6: boolean): DecodedReplayShare {
    const [, y, u, tt, th, tg, ls, apm, dp, tud, pers, pd, tp, t, ds, mt, hg, g, hpa, mb, m, hd, dd, yoy, ph, pdb] = p
    const pool = buildPool(tp)
    const milestones = isV6
        ? MILESTONE_TEMPLATES.map((tmpl, i) => {
            const row = ((m || []) as Row[])[i]
            return { ...tmpl, unlocked: row?.[0] === 1, value: (row?.[1] as number) ?? 0 }
        })
        : V5_TEMPLATES.map(tmpl => ({ ...tmpl, unlocked: ((m || []) as unknown[]).includes(tmpl.id), value: 0 }))
    const rest = common(pool, { y, tt, th, tg, ls, apm, dp, tud, pers, pd, t, ds, mt, hg, g, hpa, mb, hd, dd, yoy, ph, pdb, full: isV6 })
    return { data: { ...rest, milestones }, userName: typeof u === 'string' ? u : undefined }
}
