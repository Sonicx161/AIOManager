import { createHash } from 'node:crypto'
import { guardedWebFetch } from '../utils/safe-fetch.js'

const validRelease = value => {
    if (value == null) return true
    if (typeof value !== 'string') return false
    const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value)
    if (!match || !Number.isFinite(Date.parse(value))) return false
    const fraction = /\.(\d+)/.exec(value)?.[1] || ''
    if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) return false
    const [, year, month, day, hour, minute, second, offsetHour = '0', offsetMinute = '0'] = match
    const y = Number(year), m = Number(month)
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
    const maxDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] || 0
    return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= maxDay && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 && Number(offsetHour) <= 23 && Number(offsetMinute) <= 59
}

export function createSeriesVideosService({ fetchImpl = guardedWebFetch, now = Date.now, waitMs = 10000, cacheBytes = 64 * 1024 * 1024, maxPending = 1024 } = {}) {
    const cache = new Map(), inflight = new Map(), generations = new Map(), hosts = new Map(), owners = new Map(), freshUsage = new Map(), waiters = []
    let active = 0, cachedBytes = 0
    const removeCached = key => {
        const entry = cache.get(key)
        if (entry) cachedBytes -= entry.bytes
        cache.delete(key)
    }
    const putCached = (key, value, expires) => {
        removeCached(key)
        const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8') * 2 + key.length * 2 + 128 + (value.kind === 'list' ? value.videos.length * 128 : 0)
        if (bytes > cacheBytes) return
        cache.set(key, { value, expires, bytes })
        cachedBytes += bytes
        while (cachedBytes > cacheBytes || cache.size > 5000) removeCached(cache.keys().next().value)
    }
    const hash = value => createHash('sha256').update(value).digest('hex')
    const drain = () => {
        for (let i = 0; i < waiters.length;) {
            const w = waiters[i]
            if (active >= 32) break
            if ((owners.get(w.owner) || 0) >= 4) { i++; continue }
            waiters.splice(i, 1); clearTimeout(w.timer); active++
            owners.set(w.owner, (owners.get(w.owner) || 0) + 1)
            w.resolve(() => {
                active--
                const n = owners.get(w.owner) - 1
                if (n) owners.set(w.owner, n); else owners.delete(w.owner)
                drain()
            })
        }
    }
    const acquire = owner => new Promise(resolve => {
        if ((active >= 32 || (owners.get(owner) || 0) >= 4) && waiters.length >= maxPending) return resolve(null)
        const w = { owner, resolve, timer: null }
        w.timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); resolve(null) }, waitMs)
        waiters.push(w); drain()
    })
    const resolve = async (item, owner) => {
        let url
        try {
            if (item.id === '.' || item.id === '..' || item.type === '.' || item.type === '..') throw new Error()
            url = new URL(item.base.replace(/^stremio:\/\//i, 'https://'))
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error()
            url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/(manifest(?:\.json)?|configure)$/i, '')}/meta/${encodeURIComponent(item.type)}/${encodeURIComponent(item.id)}.json`
        } catch { return { kind: 'unknown' } }
        const key = hash(JSON.stringify([item.base, item.type, item.id]))
        const cached = cache.get(key)
        const recent = cached?.value?.kind === 'list' && Number.isFinite(cached.value.fetchedAt) && now() >= cached.value.fetchedAt && now() - cached.value.fetchedAt <= 300000
        if (cached && cached.expires > now() && (!item.fresh || recent)) { cache.delete(key); cache.set(key, cached); return cached.value }
        if (cached && cached.expires <= now()) removeCached(key)
        const flightKey = `${key}:${item.fresh ? 'fresh' : 'read'}`
        if (inflight.has(flightKey)) return inflight.get(flightKey)
        const host = hash(item.base)
        const generation = (generations.get(key) || 0) + 1
        generations.set(key, generation)
        const work = (async () => {
            const failure = hosts.get(host)
            if (failure?.until > now()) return { kind: 'unknown' }
            if (failure?.until) hosts.delete(host)
            const release = await acquire(owner)
            if (!release) return { kind: 'busy' }
            let malformed = false
            try {
                if (hosts.get(host)?.until > now()) return { kind: 'unknown' }
                if (item.fresh) {
                    const recent = (freshUsage.get(owner) || []).filter(time => now() >= time && now() - time < 60000)
                    if (recent.length >= 30) return { kind: 'busy' }
                    recent.push(now())
                    freshUsage.delete(owner)
                    freshUsage.set(owner, recent)
                    while (freshUsage.size > 5000) freshUsage.delete(freshUsage.keys().next().value)
                }
                const response = await fetchImpl(url.href, { maxBytes: 8 * 1024 * 1024, totalTimeoutMs: 10000, connectTimeoutMs: 10000, signal: AbortSignal.timeout(10000) })
                let value
                if (response.status === 404) value = { kind: 'not-found' }
                else if (!response.ok) throw new Error()
                else {
                    malformed = true
                    const data = await response.json()
                    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
                    if (data.meta === undefined) value = { kind: 'not-found' }
                    else if (!data.meta || typeof data.meta !== 'object' || Array.isArray(data.meta)) throw new Error()
                    else if (data.meta.videos === undefined) value = { kind: 'not-found' }
                    else if (!Array.isArray(data.meta.videos)) throw new Error()
                    else if (data.meta.videos.length > 10000) throw new Error()
                    else if (data.meta.videos.length === 0) value = { kind: 'not-found' }
                    else {
                        if (data.meta.videos.some(v => !v || typeof v.id !== 'string' || !v.id || v.id.length > 256 || (v.season != null && (!Number.isSafeInteger(v.season) || (v.season < 0 || v.season > 4294967295))) || (v.episode != null && (!Number.isSafeInteger(v.episode) || (v.episode < 0 || v.episode > 4294967295))) || !validRelease(v.released))) throw new Error()
                        const videos = data.meta.videos.map(v => ({ id: v.id, ...(Number.isSafeInteger(v.season) && v.season >= 0 ? { season: v.season } : {}), ...(Number.isSafeInteger(v.episode) && v.episode >= 0 ? { episode: v.episode } : {}), ...(typeof v.released === 'string' ? { released: v.released } : {}) }))
                        value = videos.length ? { kind: 'list', videos, fetchedAt: now() } : { kind: 'not-found' }
                    }
                }
                malformed = false
                hosts.delete(host)
                if (generations.get(key) === generation) putCached(key, value, now() + (value.kind === 'list' ? 21600000 : 3600000))
                return value
            } catch {
                if (malformed && generations.get(key) === generation) putCached(key, { kind: 'unknown' }, now() + 300000)
                const count = (hosts.get(host)?.count || 0) + 1
                hosts.set(host, { count, until: count >= 5 ? now() + 120000 : 0 })
                while (hosts.size > 5000) hosts.delete(hosts.keys().next().value)
                return { kind: 'unknown' }
            } finally { release() }
        })()
        inflight.set(flightKey, work)
        try { return await work } finally {
            inflight.delete(flightKey)
            if (!inflight.has(`${key}:fresh`) && !inflight.has(`${key}:read`)) generations.delete(key)
        }
    }
    return { resolve }
}
