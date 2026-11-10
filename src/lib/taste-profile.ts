import type { ActivityItem } from '@/types/activity'

function ratingToWeight(rating: number): number {
    if (rating >= 9) return 3.0
    if (rating >= 7) return 1.5
    if (rating >= 5) return 0.5
    if (rating >= 1) return -1.0
    return 0
}

export interface ExternalRating {
  imdbId: string | null
  tmdbId: number | null
  tvdbId: number | null
  title: string
  year: number | null
  type: 'movie' | 'series'
  rating: number
  ratedAt: string
  source?: 'trakt' | 'pmdb'
}

export interface TasteProfile {
  accountId: string
  computedAt: number
  totalItems: number
  totalEngagement: number
  avgEngagement: number
  genres: Record<string, { weight: number; count: number; avgRating: number }>
  eras: Record<string, number>
  types: { movie: number; series: number }
  topItems: Array<{
    itemId: string
    title: string
    engagement: number
    genres: string[]
    type: string
  }>
  topCast?: Array<{ name: string; id?: number; count: number }>
  topDirectors?: Array<{ name: string; id?: number; count: number }>
  vector: number[]
}

const ERA_KEYS = ['1980s', '1990s', '2000s', '2010s', '2020s', '2030s'] as const

const SIMILARITY_THRESHOLD = 0.3
const MIN_COMMON_GENRES = 3
const GENRE_WEIGHT_OVERLAP = 0.05
const DEFAULT_TOP_K = 3
const ABANDON_RECENT_DAYS = 7

interface ItemEngagement {
  itemId: string
  accountId: string
  name: string
  type: string
  genres: string[]
  engagement: number
  episodeCount: number
}

function clamp(v: number, min: number, max: number): number {
  if (v < min) return min
  if (v > max) return max
  return v
}

function detectDecade(year: number): string | null {
  if (year >= 1980 && year <= 1989) return '1980s'
  if (year >= 1990 && year <= 1999) return '1990s'
  if (year >= 2000 && year <= 2009) return '2000s'
  if (year >= 2010 && year <= 2019) return '2010s'
  if (year >= 2020 && year <= 2029) return '2020s'
  if (year >= 2030 && year <= 2039) return '2030s'
  return null
}

function extractYear(item: ActivityItem): number | undefined {
  if (item.firstWatched) {
    const y = new Date(item.firstWatched).getFullYear()
    if (Number.isFinite(y) && y > 1900 && y < 2100) return y
  }
  const y = item.timestamp.getFullYear()
  if (Number.isFinite(y) && y > 1900 && y < 2100) return y
  return undefined
}

function computeItemEngagement(itemId: string, items: ActivityItem[]): ItemEngagement | null {
  if (items.length === 0) return null
  const first = items[0]
  const type = first.type
  const genres = first.genres ?? []
  const name = first.name

  let engagement: number
  let episodeCount: number
  let abandoned = false

  if (type === 'movie') {
    let maxProgress = 0
    for (const it of items) if (it.progress > maxProgress) maxProgress = it.progress
    engagement = clamp(maxProgress / 30, 0.1, 1.0)
    episodeCount = 1
    if (maxProgress >= 15 && maxProgress < 30 && !(first.timesWatched && first.timesWatched > 0) && !first.isInProgress) {
      abandoned = true
    }
  } else {
    const episodeKeys = new Map<string, number>()
    for (const it of items) {
      const key = `${it.season ?? 1}:${it.episode ?? 0}`
      const prev = episodeKeys.get(key) ?? 0
      if (it.progress > prev) episodeKeys.set(key, it.progress)
    }
    episodeCount = episodeKeys.size
    if (episodeCount === 0) return null
    let sum = 0
    for (const p of episodeKeys.values()) sum += p
    const avgProgress = sum / episodeCount
    engagement = Math.min(1.0, episodeCount / 5) * clamp(avgProgress / 30, 0.1, 1.0)
    if (episodeCount === 1 && avgProgress >= 15 && avgProgress < 30 && !(first.timesWatched && first.timesWatched > 0) && !first.isInProgress) {
      abandoned = true
    }
  }

  if (abandoned) {
    let latestMs = 0
    for (const it of items) {
      const ms = it.timestamp.getTime()
      if (ms > latestMs) latestMs = ms
    }
    const daysSinceWatch = (Date.now() - latestMs) / (1000 * 60 * 60 * 24)
    if (daysSinceWatch <= ABANDON_RECENT_DAYS) {
      engagement = Math.max(engagement, 0.4)
    } else {
      engagement = -0.1
    }
  }

  return {
    itemId,
    accountId: first.accountId,
    name,
    type,
    genres,
    engagement,
    episodeCount,
  }
}

function aggregateAccountItems(items: ActivityItem[]): ItemEngagement[] {
  const groups = new Map<string, ActivityItem[]>()
  for (const it of items) {
    const arr = groups.get(it.itemId)
    if (arr) arr.push(it)
    else groups.set(it.itemId, [it])
  }
  const out: ItemEngagement[] = []
  for (const [itemId, group] of groups) {
    const r = computeItemEngagement(itemId, group)
    if (r) out.push(r)
  }
  return out
}

function l2Normalize(vec: number[]): number[] {
  let mag = 0
  for (const v of vec) mag += v * v
  mag = Math.sqrt(mag)
  if (mag === 0) return vec.slice()
  return vec.map(v => v / mag)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const n = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dot / denom
}

export function buildTasteProfile(accountId: string, items: ActivityItem[], externalRatings?: ExternalRating[]): TasteProfile {
  const own = items.filter(it => it.accountId === accountId)
  const ownByItemId = new Map(own.map(it => [it.itemId, it]))
  const aggregated = aggregateAccountItems(own)

  if (externalRatings && externalRatings.length > 0) {
    // Aggregated item ids are unique (grouped by itemId), so a Map answers the
    // same first-match lookup as Array.find without scanning all items per rating.
    const aggregatedById = new Map(aggregated.map(a => [a.itemId, a]))
    for (const r of externalRatings) {
      if (!r.imdbId || r.rating < 1) continue
      const weight = ratingToWeight(r.rating)
      if (weight === 0) continue
      const existing = aggregatedById.get(r.imdbId)
      if (existing) {
        if (weight > existing.engagement) {
          existing.engagement = weight
        }
      }
    }
  }

  const totalItems = aggregated.length
  let totalEngagement = 0
  for (const a of aggregated) totalEngagement += a.engagement

  const genreAccum = new Map<string, { sum: number; count: number }>()
  for (const a of aggregated) {
    for (const g of a.genres) {
      const cur = genreAccum.get(g)
      if (cur) {
        cur.sum += a.engagement
        cur.count += 1
      } else {
        genreAccum.set(g, { sum: a.engagement, count: 1 })
      }
    }
  }

  const genres: TasteProfile['genres'] = {}
  for (const [g, v] of genreAccum) {
    genres[g] = {
      weight: totalEngagement > 0 ? v.sum / totalEngagement : 0,
      count: v.count,
      avgRating: v.count > 0 ? v.sum / v.count : 0,
    }
  }

  const eras: Record<string, number> = {}
  let movieEngagement = 0
  let seriesEngagement = 0
  for (const a of aggregated) {
    const sample = ownByItemId.get(a.itemId)
    if (sample) {
      const year = extractYear(sample)
      if (year !== undefined) {
        const decade = detectDecade(year)
        if (decade) eras[decade] = (eras[decade] ?? 0) + a.engagement
      }
    }
    if (a.type === 'movie') movieEngagement += a.engagement
    else if (a.type === 'series' || a.type === 'anime') seriesEngagement += a.engagement
  }

  if (totalEngagement > 0) {
    for (const k of Object.keys(eras)) eras[k] = eras[k] / totalEngagement
  }
  const types = {
    movie: totalEngagement > 0 ? movieEngagement / totalEngagement : 0,
    series: totalEngagement > 0 ? seriesEngagement / totalEngagement : 0,
  }

  const topItems = aggregated
    .slice()
    .sort((x, y) => y.engagement - x.engagement)
    .slice(0, 10)
    .map(a => ({
      itemId: a.itemId,
      title: a.name,
      engagement: a.engagement,
      genres: a.genres,
      type: a.type,
    }))

  const castAccum = new Map<string, { name: string; id?: number; count: number }>()
  const directorAccum = new Map<string, { name: string; id?: number; count: number }>()
  for (const a of aggregated) {
    const sample = ownByItemId.get(a.itemId)
    if (!sample) continue
    const enriched = sample as ActivityItem & {
      cast?: Array<{ name?: string; id?: number }>
      crew?: Array<{ name?: string; id?: number; job?: string }>
    }
    if (Array.isArray(enriched.cast)) {
      for (const c of enriched.cast) {
        if (!c || !c.name) continue
        const key = c.id !== undefined ? `i:${c.id}` : `n:${c.name}`
        const cur = castAccum.get(key)
        if (cur) cur.count += 1
        else castAccum.set(key, { name: c.name, id: c.id, count: 1 })
      }
    }
    if (Array.isArray(enriched.crew)) {
      for (const c of enriched.crew) {
        if (!c || !c.name || c.job !== 'Director') continue
        const key = c.id !== undefined ? `i:${c.id}` : `n:${c.name}`
        const cur = directorAccum.get(key)
        if (cur) cur.count += 1
        else directorAccum.set(key, { name: c.name, id: c.id, count: 1 })
      }
    }
  }
  const topCast = Array.from(castAccum.values())
    .sort((x, y) => y.count - x.count)
    .slice(0, 5)
  const topDirectors = Array.from(directorAccum.values())
    .sort((x, y) => y.count - x.count)
    .slice(0, 5)

  const sortedGenres = Object.keys(genres).sort()
  const vectorRaw: number[] = [
    ...sortedGenres.map(g => genres[g].weight),
    ...ERA_KEYS.map(e => eras[e] ?? 0),
    types.movie,
    types.series,
  ]
  const vector = l2Normalize(vectorRaw)

  const avgEngagement = totalItems > 0 ? totalEngagement / totalItems : 0

  return {
    accountId,
    computedAt: Date.now(),
    totalItems,
    totalEngagement,
    avgEngagement,
    genres,
    eras,
    types,
    topItems,
    topCast: topCast.length > 0 ? topCast : undefined,
    topDirectors: topDirectors.length > 0 ? topDirectors : undefined,
    vector,
  }
}

function buildAlignedVectors(target: TasteProfile, other: TasteProfile): [number[], number[]] {
  const genreSet = new Set<string>()
  for (const k of Object.keys(target.genres)) genreSet.add(k)
  for (const k of Object.keys(other.genres)) genreSet.add(k)
  const sortedGenres = Array.from(genreSet).sort()

  const a: number[] = [
    ...sortedGenres.map(g => target.genres[g]?.weight ?? 0),
    ...ERA_KEYS.map(e => target.eras[e] ?? 0),
    target.types.movie,
    target.types.series,
  ]
  const b: number[] = [
    ...sortedGenres.map(g => other.genres[g]?.weight ?? 0),
    ...ERA_KEYS.map(e => other.eras[e] ?? 0),
    other.types.movie,
    other.types.series,
  ]
  return [l2Normalize(a), l2Normalize(b)]
}

function weightedGenreSet(profile: TasteProfile): Set<string> {
  const out = new Set<string>()
  for (const [g, v] of Object.entries(profile.genres)) {
    if (v.weight > GENRE_WEIGHT_OVERLAP) out.add(g)
  }
  return out
}

export function findSimilarAccounts(
  target: TasteProfile,
  others: TasteProfile[],
  minSharedItems?: number
): Array<{ profile: TasteProfile; similarity: number }> {
  const targetGenres = weightedGenreSet(target)
  const targetItems = new Set(target.topItems.map(t => t.itemId))

  const scored: Array<{ profile: TasteProfile; similarity: number }> = []

  for (const other of others) {
    if (other.accountId === target.accountId) continue

    const otherGenres = weightedGenreSet(other)
    let common = 0
    for (const g of targetGenres) if (otherGenres.has(g)) common++
    if (common < MIN_COMMON_GENRES) continue

    if (minSharedItems !== undefined && minSharedItems > 0) {
      const otherItems = new Set(other.topItems.map(t => t.itemId))
      let shared = 0
      for (const id of targetItems) if (otherItems.has(id)) shared++
      if (shared < minSharedItems) continue
    }

    const [va, vb] = buildAlignedVectors(target, other)
    const sim = cosineSimilarity(va, vb)
    if (sim < SIMILARITY_THRESHOLD) continue

    scored.push({ profile: other, similarity: sim })
  }

  scored.sort((x, y) => y.similarity - x.similarity)
  return scored.slice(0, DEFAULT_TOP_K)
}

export function computeHouseholdPopularity(
  profiles: TasteProfile[],
  allItems: ActivityItem[]
): Array<{ itemId: string; title: string; watchers: number; avgEngagement: number }> {
  void profiles

  const byItem = new Map<string, ActivityItem[]>()
  for (const it of allItems) {
    const arr = byItem.get(it.itemId)
    if (arr) arr.push(it)
    else byItem.set(it.itemId, [it])
  }

  interface Row {
    itemId: string
    title: string
    watchers: number
    avgEngagement: number
    score: number
  }
  const rows: Row[] = []

  for (const [itemId, group] of byItem) {
    const byAccount = new Map<string, ActivityItem[]>()
    for (const it of group) {
      const arr = byAccount.get(it.accountId)
      if (arr) arr.push(it)
      else byAccount.set(it.accountId, [it])
    }

    const perAccount: ItemEngagement[] = []
    for (const [accId, accItems] of byAccount) {
      const r = computeItemEngagement(itemId, accItems)
      if (r && r.accountId === accId) perAccount.push(r)
    }
    if (perAccount.length === 0) continue

    const watchers = perAccount.length
    let sumEng = 0
    let maxEng = 0
    for (const p of perAccount) {
      sumEng += p.engagement
      if (p.engagement > maxEng) maxEng = p.engagement
    }
    const avgEngagement = sumEng / watchers
    const qualityProxy = maxEng
    const score = watchers * avgEngagement * qualityProxy

    rows.push({
      itemId,
      title: perAccount[0].name,
      watchers,
      avgEngagement,
      score,
    })
  }

  rows.sort((a, b) => b.score - a.score)
  return rows.map(({ itemId, title, watchers, avgEngagement }) => ({
    itemId,
    title,
    watchers,
    avgEngagement,
  }))
}
