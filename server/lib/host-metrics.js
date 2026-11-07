// Host/process metrics sampler for the Dashboard: fixed-size in-memory ring, no DB writes.
import os from 'os'
import fs from 'fs'
import { monitorEventLoopDelay } from 'perf_hooks'
import db from '../db.js'
import { DATA_DIR } from '../config.js'
import { registerTask } from './ops-metrics.js'

const mb = (n) => Math.round((n / 1048576) * 10) / 10
const share = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null)

// Busy share of CPU time between two os.cpus() snapshots; null when not computable.
export function cpuBusyPct(prev, next) {
    if (!Array.isArray(prev) || !Array.isArray(next) || prev.length === 0 || prev.length !== next.length) return null
    let busy = 0
    let total = 0
    for (let i = 0; i < prev.length; i++) {
        const p = prev[i]?.times
        const n = next[i]?.times
        if (!p || !n) return null
        const used = (n.user - p.user) + (n.nice - p.nice) + (n.sys - p.sys) + (n.irq - p.irq)
        busy += used
        total += used + (n.idle - p.idle)
    }
    return total > 0 ? Math.round((busy / total) * 1000) / 10 : null
}

const statSize = async (p) => {
    try { return (await fs.promises.stat(p)).size } catch { return null }
}

export function createHostMetricsSampler({ intervalMs = 60_000, points = 60, cpus = () => os.cpus(), now = () => Date.now() } = {}) {
    const histogram = monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()
    const ring = []
    let lastCpus = null
    let lastSampleAt = null
    let inflight = null
    let stopped = false
    let requestsTotal = 0
    let errorsTotal = 0
    let windowReqStart = 0
    let windowErrStart = 0
    let dbInfo = { type: db.type, healthy: null, mainBytes: null, walBytes: null, shmBytes: null, totalBytes: null }
    let diskInfo = { available: null, freeBytes: null, totalBytes: null, usedPct: null }
    const ms = (ns) => Math.round(ns / 1e5) / 10

    const safeCpus = () => {
        try {
            const snap = cpus()
            return Array.isArray(snap) && snap.length ? snap : null
        } catch { return null }
    }

    // One size read per sample; PostgreSQL asks pg_database_size at most once per tick.
    async function measureDb() {
        const healthy = await db.healthCheck().catch(() => false)
        const info = { type: db.type, healthy, mainBytes: null, walBytes: null, shmBytes: null, totalBytes: null }
        try {
            if (db.type === 'postgres') {
                if (healthy) {
                    const row = await db.get('SELECT pg_database_size(current_database()) AS bytes', [])
                    info.mainBytes = Number(row?.bytes) || null
                }
            } else {
                const path = db.dbPath || process.env.SQLITE_DB_PATH
                if (path && path !== ':memory:') {
                    info.mainBytes = await statSize(path)
                    info.walBytes = await statSize(`${path}-wal`)
                    info.shmBytes = await statSize(`${path}-shm`)
                }
            }
        } catch { /* sizes are best effort */ }
        const parts = [info.mainBytes, info.walBytes, info.shmBytes].filter((n) => typeof n === 'number')
        info.totalBytes = parts.length ? parts.reduce((a, b) => a + b, 0) : null
        dbInfo = info
    }

    async function measureDisk() {
        try {
            if (typeof fs.promises.statfs !== 'function') throw new Error('statfs unavailable')
            const s = await fs.promises.statfs(DATA_DIR)
            const free = Number(s.bsize) * Number(s.bavail)
            const total = Number(s.bsize) * Number(s.blocks)
            diskInfo = { available: true, freeBytes: free, totalBytes: total, usedPct: share(total - free, total) }
        } catch {
            diskInfo = { available: false, freeBytes: null, totalBytes: null, usedPct: null }
        }
    }

    async function runSample() {
        const t = now()
        const snap = safeCpus()
        const cpuPct = cpuBusyPct(lastCpus, snap)
        if (snap) lastCpus = snap
        const total = os.totalmem()
        const used = total - os.freemem()
        const mem = process.memoryUsage()
        const reqCount = requestsTotal - windowReqStart
        const errCount = errorsTotal - windowErrStart
        windowReqStart = requestsTotal
        windowErrStart = errorsTotal
        await Promise.all([measureDb(), measureDisk()])
        ring.push({ t, cpuPct, memUsedPct: share(used, total), rssMb: mb(mem.rss), heapMb: mb(mem.heapUsed), loopP99Ms: ms(histogram.percentile(99)), reqCount, errCount })
        if (ring.length > points) ring.shift()
        lastSampleAt = t
        histogram.reset()
    }

    // Overlapping calls await the in-flight sample instead of skipping it.
    function sample() {
        if (inflight) return inflight
        if (stopped) return Promise.resolve()
        inflight = runSample().finally(() => { inflight = null })
        return inflight
    }

    const timer = setInterval(() => { sample().catch(() => {}) }, intervalMs)
    timer.unref?.()
    const ready = sample().catch(() => {})
    registerTask('host-metrics', { label: 'Host metrics sampler (CPU, memory, disk, database)', intervalMs, lastRunAt: () => lastSampleAt })

    return {
        intervalMs,
        points,
        ready,
        sample,
        stop: () => { stopped = true; clearInterval(timer); histogram.disable() },
        countResponse(statusCode) {
            requestsTotal++
            if (statusCode >= 500 && statusCode < 600) errorsTotal++
        },
        series: () => ring.slice(),
        dbSnapshot: () => ({ ...dbInfo }),
        diskSnapshot: () => ({ ...diskInfo }),
        live() {
            const t = now()
            const snap = safeCpus()
            const total = os.totalmem()
            const used = total - os.freemem()
            const mem = process.memoryUsage()
            const load = os.loadavg()
            return {
                t,
                cpuPct: cpuBusyPct(lastCpus, snap),
                cpuWindowMs: lastSampleAt ? t - lastSampleAt : null,
                loadavg: load.some((n) => n > 0) ? load.map((n) => Math.round(n * 100) / 100) : null,
                memUsedBytes: used,
                memTotalBytes: total,
                memUsedPct: share(used, total),
                rssMb: mb(mem.rss),
                heapUsedMb: mb(mem.heapUsed),
                heapTotalMb: mb(mem.heapTotal),
                loopP50Ms: ms(histogram.percentile(50)),
                loopP99Ms: ms(histogram.percentile(99)),
                uptimeSec: Math.round(process.uptime()),
                hostUptimeSec: Math.round(os.uptime()),
                requestsTotal,
                errorsTotal,
            }
        },
    }
}
