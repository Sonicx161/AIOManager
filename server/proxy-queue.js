import { DOMAIN_THROTTLE_MS, MAX_QUEUE_PER_KEY, MAX_QUEUE_SIZE, PROXY_CONCURRENCY_LIMIT } from './config.js'
import { domainLastRequestTime, proxyQueue, proxyQueueKeyCounts, serverState } from './state.js'

const MAX_SCAN = 200

const releaseKey = (request) => {
    if (!request.queueKey) return
    const count = proxyQueueKeyCounts.get(request.queueKey) || 1
    const newCount = count - 1
    if (newCount <= 0) { proxyQueueKeyCounts.delete(request.queueKey) } else { proxyQueueKeyCounts.set(request.queueKey, newCount) }
}

const runQueuedTask = async (request) => {
    try {
        const result = await request.task()
        request.resolve(result)
    } catch (err) {
        request.reject(err)
    } finally {
        releaseKey(request)
        serverState.activeProxyRequests--
        processQueue()
    }
}

export const processQueue = async () => {
    if (proxyQueue.length === 0 || serverState.activeProxyRequests >= PROXY_CONCURRENCY_LIMIT) return

    const now = Date.now()
    if (domainLastRequestTime.size > 1000 && now - serverState.domainLastPruneTime > 30000) {
        serverState.domainLastPruneTime = now
        const pruneThreshold = now - (5 * 60 * 1000)
        for (const [domain, lastTime] of domainLastRequestTime.entries()) {
            if (lastTime < pruneThreshold) domainLastRequestTime.delete(domain)
        }
        if (domainLastRequestTime.size > 1000) {
            const keys = Array.from(domainLastRequestTime.keys()).slice(0, 200)
            keys.forEach(k => domainLastRequestTime.delete(k))
        }
    }

    let minThrottleWait = Infinity
    for (let i = 0; i < proxyQueue.length && i < MAX_SCAN;) {
        if (serverState.activeProxyRequests >= PROXY_CONCURRENCY_LIMIT) return

        const request = proxyQueue[i]
        const origin = request.origin

        const lastRequest = domainLastRequestTime.get(origin) || 0
        const waitTime = Math.max(0, (request.throttleMs ?? DOMAIN_THROTTLE_MS) - (Date.now() - lastRequest))
        if (waitTime > 0) {
            if (waitTime < minThrottleWait) minThrottleWait = waitTime
            i++
            continue
        }

        proxyQueue.splice(i, 1)
        if (request.expiryTimer) clearTimeout(request.expiryTimer)
        domainLastRequestTime.set(origin, Date.now())
        serverState.activeProxyRequests++
        runQueuedTask(request)
    }

    if (minThrottleWait !== Infinity) scheduleWake(Math.max(Math.min(minThrottleWait, 60000), 10))
}

// One wake-up timer for throttled entries: every enqueue and completion used to add its own, so a busy queue
// of same-origin follow-ups (host probe, then manifest) ran processQueue thousands of times per second.
let wakeTimer = null
let wakeAt = Infinity
const scheduleWake = (waitMs) => {
    const at = Date.now() + waitMs
    if (wakeTimer && wakeAt <= at) return
    if (wakeTimer) clearTimeout(wakeTimer)
    wakeAt = at
    wakeTimer = setTimeout(() => {
        wakeTimer = null
        wakeAt = Infinity
        processQueue()
    }, waitMs)
}

export const enqueueProxyRequest = (url, task, options = null) => {
    return new Promise((resolve, reject) => {
        if (proxyQueue.length >= MAX_QUEUE_SIZE) {
            reject(new Error('Proxy queue saturated. Please try again in a moment.'))
            return
        }
        const queueOptions = typeof options === 'string'
            ? { queueKey: options }
            : (options || {})
        const { queueKey = null, throttleMs = DOMAIN_THROTTLE_MS, maxPerKey = MAX_QUEUE_PER_KEY, deadline = null } = queueOptions
        if (queueKey) {
            const current = proxyQueueKeyCounts.get(queueKey) || 0
            if (current >= maxPerKey) {
                reject(new Error('Too many pending requests. Please try again in a moment.'))
                return
            }
            proxyQueueKeyCounts.set(queueKey, current + 1)
        }
        let origin = ''
        try {
            origin = new URL(url).origin
        } catch (e) { origin = url }
        const entry = { url, origin, task, resolve, reject, queueKey, throttleMs, expiryTimer: null }
        // An entry still waiting at its deadline leaves the queue without taking a slot or stamping its origin.
        if (deadline) {
            entry.expiryTimer = setTimeout(() => {
                const index = proxyQueue.indexOf(entry)
                if (index < 0) return
                proxyQueue.splice(index, 1)
                releaseKey(entry)
                reject(Object.assign(new Error('Proxy queue wait exceeded'), { code: 'queue-timeout' }))
            }, Math.max(0, deadline - Date.now()))
        }
        proxyQueue.push(entry)
        processQueue()
    })
}
