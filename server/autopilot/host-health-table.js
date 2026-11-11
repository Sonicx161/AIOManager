// Autopilot health state per target, in memory only. One evaluation per target per cycle, shared by every
// rule, owner and caller; verdicts persist across cycles. A restart starts every target UNKNOWN.
import { createHash } from 'node:crypto'
import { VERDICT, STRENGTH, targetFor, registrableDomain, classifyManifestRead, responseFingerprint } from './health-signals.js'

export const STATE = Object.freeze({ UNKNOWN: 'UNKNOWN', UP: 'UP', FAILING: 'FAILING', DOWN: 'DOWN', RECOVERING: 'RECOVERING' })
// DOWN after 2 bad cycles in a row or 3 of the last 5; UP again after 4 good in a row. DEFER moves nothing.
export const FAIL_STREAK = 2
export const FAIL_WINDOW = 5
export const FAIL_IN_WINDOW = 3
export const RECOVER_STREAK = 4

export const TARGETS_MAX = Math.max(100, parseInt(process.env.AUTOPILOT_HEALTH_TARGETS_MAX || '20000', 10) || 20000)
const TARGET_BYTES_MAX = 32 * 1024 * 1024
const UNREFERENCED_MS = 30 * 60 * 1000
// Targets referenced this recently are pinged at the start of every cycle.
const ACTIVE_REFERENCE_MS = 5 * 60 * 1000
const SAMPLES_PER_TARGET = 8
const SAMPLE_URL_MAX = 8192
const CUSTOM_URL_MAX = 2048
const OWNER_MAX = 128
// Over a cap, eviction runs once down to this share of it.
const EVICT_TO = 0.9
// Outside a cycle (the Addon Health route) a verdict this fresh is reused instead of pinging again.
export const CACHED_VERDICT_MS = 60 * 1000
export const PING_CONCURRENCY = 256
// Pings are one GET per target per cycle; this caps how many hit one origin at once.
export const PINGS_PER_ORIGIN = 4
// Manifest backup reads on the trip cycle: one for HTTP-level DOWN, up to three for SUSPECT, within 15 s.
export const GATE_READS_SUSPECT = 3
export const GATE_BUDGET_MS = 15000
// A backup read always gets at least this much time, even past the cycle's deadline.
const GATE_MIN_MS = 500
// A by-design answer a read showed to be the app's normal reply (a root or config-free route that 404s)
// counts good for a day, then is read again. Failure signatures (5xx, edge, proxy pages) never do.
const BASELINE_MS = 24 * 60 * 60 * 1000
const BASELINE_ROWS = new Set(['root-404', 'route-gone'])
// A DOWN target failing at HTTP level, or one whose reads keep deferring, is read again at most every few
// cycles. A root 404 identical to Traefik's (a Go server's default) is trusted for as long.
const DOWN_READ_EVERY_CYCLES = 5
// EAI_AGAIN defers until it repeats this many cycles in a row on one target.
const RESOLVER_REPEAT_CYCLES = 3
// Egress breaker: at least half of 4+ registrable domains failing at transport level (or EAI_AGAIN on 3+
// domains) defers that cycle's transport failures, for at most 5 cycles in a row. It judges the results
// completed shortly before the ping deadline, so one slow host cannot hide the rest.
const BREAKER_MIN_DOMAINS = 4
const BREAKER_RESOLVER_DOMAINS = 3
const BREAKER_MAX_CYCLES = 5
// Cycles a target's failure may be suppressed before it commits whatever the breaker says: breaker trips,
// uncertainty holds, the resolver grace and confirmation reads that decide nothing all spend this one budget,
// and only a non-failing result for the target refills it. Confirmation reads always run, so a read showing
// the app answering still counts good after the budget is spent. A target that keeps failing at transport
// level or with a strength-H answer therefore reaches DOWN within 7 judgments of its failures (5 suppressions
// + 2 failing steps). A SUSPECT answer never commits without a decisive read, by design.
const SUPPRESS_MAX = 5

export const outcomeOf = (verdict) => {
    if (verdict === VERDICT.UP || verdict === VERDICT.DEGRADED) return 'good'
    if (verdict === VERDICT.DOWN || verdict === VERDICT.SUSPECT) return 'bad'
    return 'defer'
}

// Moves one target by one cycle outcome. Pure apart from mutating the entry.
export function stepState(entry, outcome) {
    if (outcome !== 'good' && outcome !== 'bad') return entry.state
    const bad = outcome === 'bad'
    entry.bits.unshift(bad)
    if (entry.bits.length > FAIL_WINDOW) entry.bits.length = FAIL_WINDOW
    if (bad) {
        entry.badStreak++
        entry.goodStreak = 0
    } else {
        entry.goodStreak++
        entry.badStreak = 0
    }
    const badInWindow = entry.bits.filter(Boolean).length
    const trips = entry.badStreak >= FAIL_STREAK || badInWindow >= FAIL_IN_WINDOW
    switch (entry.state) {
        case STATE.UNKNOWN:
            entry.state = bad ? STATE.FAILING : STATE.UP
            break
        case STATE.UP:
            if (bad) entry.state = trips ? STATE.DOWN : STATE.FAILING
            break
        case STATE.FAILING:
            if (bad && trips) entry.state = STATE.DOWN
            else if (!bad && badInWindow < FAIL_IN_WINDOW) entry.state = STATE.UP
            break
        case STATE.DOWN:
            if (!bad) entry.state = entry.goodStreak >= RECOVER_STREAK ? STATE.UP : STATE.RECOVERING
            break
        case STATE.RECOVERING:
            if (bad) entry.state = STATE.DOWN
            else if (entry.goodStreak >= RECOVER_STREAK) entry.state = STATE.UP
            break
    }
    return entry.state
}

// Whether one more bad cycle would move the target into DOWN: the cycle that runs the backup read.
export function wouldTrip(entry) {
    if (entry.state === STATE.DOWN || entry.state === STATE.UNKNOWN) return false
    if (entry.state === STATE.RECOVERING) return true
    const badStreak = entry.badStreak + 1
    const badInWindow = entry.bits.slice(0, FAIL_WINDOW - 1).filter(Boolean).length + 1
    return badStreak >= FAIL_STREAK || badInWindow >= FAIL_IN_WINDOW
}

// Egress breaker over one cycle's ping results: [{ domain, result }].
export function breakerTrips(results) {
    const byDomain = new Map()
    for (const { domain, result } of results) {
        let d = byDomain.get(domain)
        if (!d) byDomain.set(domain, d = { total: 0, transport: 0, resolver: 0 })
        d.total++
        if (result.transport && result.verdict !== VERDICT.UP && result.verdict !== VERDICT.DEGRADED) d.transport++
        if (result.resolver) d.resolver++
    }
    const domains = byDomain.size
    let failed = 0
    let resolver = 0
    for (const d of byDomain.values()) {
        if (d.transport === d.total) failed++
        if (d.resolver > 0) resolver++
    }
    return { trips: (domains >= BREAKER_MIN_DOMAINS && failed * 2 >= domains) || resolver >= BREAKER_RESOLVER_DOMAINS, domains, failed, resolver }
}

const hashKey = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 32)

// A custom check URL is its own target. Its key is a hash, so a token in the URL is never a key.
export const customTargetFor = (url) => {
    try {
        const u = new URL(String(url))
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
        if (u.href.length > CUSTOM_URL_MAX) return null
        return { key: `custom:${hashKey(u.href)}`, probeUrl: u.href, origin: u.origin, prefix: '', app: null, kind: 'custom', learned: true, appNotFound: null }
    } catch { return null }
}

const domainOf = (target) => {
    try { return registrableDomain(new URL(target.origin).hostname) } catch { return target.origin }
}

// Global concurrency plus a per-origin cap. Each origin queues on its own, so one host with many targets
// never holds the pipeline's slots while waiting for its own.
const limiter = (limit, perKey) => {
    let active = 0
    const byKey = new Map()
    const ready = []
    const pump = () => {
        while (active < limit && ready.length > 0) {
            const key = ready.shift()
            const slot = byKey.get(key)
            if (!slot || slot.queue.length === 0 || slot.active >= perKey) continue
            const { fn, resolve, reject } = slot.queue.shift()
            slot.active++
            active++
            if (slot.queue.length > 0 && slot.active < perKey) ready.push(key)
            Promise.resolve().then(fn).then(resolve, reject).finally(() => {
                slot.active--
                active--
                if (slot.queue.length > 0) ready.push(key)
                else if (slot.active === 0) byKey.delete(key)
                pump()
            })
        }
    }
    return (key, fn) => new Promise((resolve, reject) => {
        let slot = byKey.get(key)
        if (!slot) byKey.set(key, slot = { active: 0, queue: [] })
        slot.queue.push({ fn, resolve, reject })
        if (slot.active < perKey) ready.push(key)
        pump()
    })
}

// A backup read is judged on its own first: the app's answers (including its JSON config errors) and DEFER
// reads always win. Only an otherwise inconclusive read that answers exactly like a proxy-default or edge
// ping (same status and fingerprint, not JSON) is the proxy or platform answering for a missing app: down.
// A read that spent its budget queued for a slot is DEFER, never evidence.
const EDGE_ROWS = new Set(['proxy-default-page', 'caddy-empty-200', 'root-404', 'paas-no-app'])
const readVerdict = (outcome, ping) => {
    if (outcome?.queued) return 'defer'
    const verdict = classifyManifestRead(outcome)
    if (verdict !== 'inconclusive' || outcome?.error) return verdict
    const json = /^\s*[[{]/.test(outcome?.peek ?? '')
    // A server error at the root that the user's manifest repeats (the same non-JSON status, or any 5xx after
    // a 5xx ping) is the server not serving. The owner-majority vote still keeps an app whose root errors by
    // design but whose manifests answer.
    if (ping.row === 'server-error' && outcome.status >= 500) return 'down'
    if ((ping.row === 'server-error' || ping.row === 'unmatched') && outcome.status === ping.status && !json) return 'down'
    const sameEdgePage = EDGE_ROWS.has(ping.row) && !json
        && outcome?.status === ping.status && responseFingerprint(outcome) === ping.fingerprint
    return sameEdgePage ? 'down' : verdict
}

export function createHostHealthTable({
    ping, readManifest = null, now = () => Date.now(), log = null, maxEntries = TARGETS_MAX, maxBytes = TARGET_BYTES_MAX,
    pingBudgetMs = 30000, pingConcurrency = PING_CONCURRENCY, pingsPerOrigin = PINGS_PER_ORIGIN, gateBudgetMs = GATE_BUDGET_MS,
} = {}) {
    const entries = new Map()
    const limited = limiter(pingConcurrency, pingsPerOrigin)
    let cycle = 0
    let inCycle = false
    let deadlineAt = Infinity
    // The cycle's judgment point at the latest, a little before the deadline.
    let judgmentCutoffAt = Infinity
    let deadline = Promise.resolve()
    // Transport verdicts of the cycle, applied together at the judgment point with one breaker decision (see judge).
    let judged = true
    let judgment = Promise.resolve({ trips: false, applies: false })
    let transportBatch = new Map()
    let downAtStart = new Set()
    // Evaluations of the cycle still waiting for their ping; the judgment waits for them (or the cutoff).
    let pending = null
    let fireJudgment = () => {}
    let breakerRun = 0
    let breakerHeldLogged = false
    const stats = { gateReads: 0, overdue: 0, stale: 0, carried: 0, lateTransport: 0, carriedConclusions: 0, heldDown: 0, breakerTrips: 0 }

    // Every string an entry retains is counted: the key, the target's URLs and each sample's URL and owner.
    let totalBytes = 0
    const strBytes = (value) => (typeof value === 'string' ? value.length * 2 : 0)
    const entryBytes = (entry) => {
        const t = entry.target
        let bytes = 400 + strBytes(entry.key) + strBytes(t.probeUrl) + strBytes(t.origin) + strBytes(t.prefix) + strBytes(t.app)
        for (const [url, sample] of entry.samples) bytes += 64 + strBytes(url) + strBytes(sample.owner)
        return bytes
    }
    const account = (entry) => {
        const bytes = entryBytes(entry)
        totalBytes += bytes - entry.bytes
        entry.bytes = bytes
    }
    const remove = (entry) => {
        entries.delete(entry.key)
        totalBytes -= entry.bytes
    }

    // Over either cap, one pass evicts down to 90% of both: targets unreferenced for 30 minutes first, then
    // the least recently referenced. In-flight targets stay.
    const evict = () => {
        if (entries.size <= maxEntries && totalBytes <= maxBytes) return
        const keepEntries = Math.floor(maxEntries * EVICT_TO)
        const keepBytes = Math.floor(maxBytes * EVICT_TO)
        const cutoff = now() - UNREFERENCED_MS
        const order = [...entries.values()].sort((a, b) => (b.referencedAt < cutoff) - (a.referencedAt < cutoff) || a.referencedAt - b.referencedAt)
        for (const entry of order) {
            if (entries.size <= keepEntries && totalBytes <= keepBytes) break
            if (!entry.inflight) remove(entry)
        }
    }

    const entryFor = (target) => {
        let entry = entries.get(target.key)
        if (!entry) {
            entry = {
                key: target.key, target, baseline: null, readCycle: -Infinity, judgedCycle: -1, carry: null, cyclePing: null, state: STATE.UNKNOWN, bits: [],
                badStreak: 0, goodStreak: 0, resolverStreak: 0, lateResult: null, steppedCycle: -1, landedCycle: -1, suppressed: 0, last: null, lastGood: null, evalCycle: -1,
                evaluation: null, evalSettledCycle: -1, inflight: null, referencedAt: now(), samples: new Map(), bytes: 0,
            }
            entries.set(target.key, entry)
            account(entry)
            evict()
        }
        entry.referencedAt = now()
        return entry
    }

    // Remembers up to 8 URLs per target as candidates for a backup read.
    const remember = (entry, url, owner, inUse) => {
        if (typeof url !== 'string' || url.length > SAMPLE_URL_MAX) return
        const prev = entry.samples.get(url)
        const ownerKey = typeof owner === 'string' && owner.length > OWNER_MAX ? `h:${hashKey(owner)}` : (owner ?? null)
        const used = !!inUse
        entry.samples.delete(url)
        // An unchanged sample is re-inserted as is; only its Map position moves.
        entry.samples.set(url, prev && prev.owner === ownerKey && prev.inUse === used ? prev : { owner: ownerKey, inUse: used, readAt: prev?.readAt ?? 0 })
        while (entry.samples.size > SAMPLES_PER_TARGET) entry.samples.delete(entry.samples.keys().next().value)
        account(entry)
        if (totalBytes > maxBytes) evict()
    }

    // URLs in use first, then the least recently read, one per owner, skipping owners already read.
    const ownerOf = (url, sample) => sample?.owner ?? `url:${url}`
    const pickSamples = (entry, k, skipOwners = []) => {
        const ordered = [...entry.samples.entries()].sort((a, b) => (b[1].inUse - a[1].inUse) || (a[1].readAt - b[1].readAt))
        const owners = new Set(skipOwners)
        const picked = []
        for (const [url, sample] of ordered) {
            if (picked.length >= k) break
            const owner = ownerOf(url, sample)
            if (owners.has(owner)) continue
            owners.add(owner)
            picked.push(url)
        }
        return picked
    }

    // A custom check that cannot be reached says nothing about the addon: DEFER, never a failure. A check
    // refused by the SSRF guard is a bad check URL, not an unreachable one, and still fails.
    const unreachableDefers = (target, result) => (target.kind === 'custom' && result?.transport && result.row !== 'blocked'
        ? { ...result, verdict: VERDICT.DEFER, strength: null, resolver: false, retry: 0 }
        : result)

    const pingOnce = (entry) => {
        if (entry.inflight) return entry.inflight
        const target = entry.target
        // A ping's in-check retry must finish before the cycle's judgment point.
        const due = inCycle ? judgmentCutoffAt : Infinity
        const flight = limited(target.origin, () => ping(target, { deadlineAt: due })).then(result => unreachableDefers(target, result))
            .finally(() => { if (entry.inflight === flight) entry.inflight = null })
        entry.inflight = flight
        return flight
    }

    const record = (entry, result) => {
        entry.last = { ...result, at: now() }
        if (result.verdict === VERDICT.UP || result.verdict === VERDICT.DEGRADED) entry.lastGood = entry.last
    }

    // This cycle's ping result: a non-transport result carried from the last cycle's deadline is used instead
    // of pinging again, so a slow target is never starved; otherwise one shared ping.
    const pingForCycle = (entry) => {
        if (entry.cyclePing?.cycle === cycle) return entry.cyclePing.promise
        let promise
        if (entry.carry && entry.carry.cycle === cycle - 1) {
            stats.carried++
            promise = Promise.resolve(entry.carry.result)
        } else {
            promise = pingOnce(entry)
        }
        entry.carry = null
        entry.cyclePing = { cycle, promise }
        return promise
    }

    // Backup reads. HTTP-level DOWN counts bad unless a read shows the app answered; SUSPECT (including a
    // response timeout) counts bad only when the decisive reads agree it is down. A read that is rate limited
    // or challenged is no evidence: with nothing decisive the cycle defers and the ping evidence stands.
    const readAll = (entry, result, urls, budgetMs) => {
        const readAt = now()
        for (const url of urls) {
            const sample = entry.samples.get(url)
            if (sample) sample.readAt = readAt
        }
        stats.gateReads += urls.length
        return Promise.all(urls.map(url => Promise.resolve()
            .then(() => readManifest(url, budgetMs))
            .then(outcome => readVerdict(outcome, result), () => 'inconclusive')))
    }

    const gate = async (entry, result, k, budgetMs) => {
        if (!readManifest || entry.target.kind === 'custom') return 'bad'
        const suspect = result.verdict === VERDICT.SUSPECT
        const urls = pickSamples(entry, k)
        if (urls.length === 0) return suspect ? 'defer' : 'bad'
        const startedAt = Date.now()
        entry.revalidate = false
        const reads = await readAll(entry, result, urls, budgetMs)
        // An UP gateway root reads one owner first; when that read does not show the app, the other owners are
        // read before the 502 counts, within what is left of the budget.
        if (result.row === 'gateway' && entry.state === STATE.UP && !reads.includes('app')) {
            const more = pickSamples(entry, GATE_READS_SUSPECT - urls.length, urls.map(url => ownerOf(url, entry.samples.get(url))))
            const left = budgetMs - (Date.now() - startedAt)
            if (more.length > 0 && left > 0) reads.push(...await readAll(entry, result, more, left))
        }
        entry.readCycle = cycle
        const down = reads.filter(r => r === 'down').length
        const app = reads.filter(r => r === 'app').length
        if (suspect) return app > down ? 'app' : down > app ? 'bad' : 'defer'
        // Behind a 502/503/504 root, any owner whose manifest answers shows the app is serving: one owner's
        // JSON 500 is that owner's config. Every sampled owner failing still trips.
        if (result.row === 'gateway' && app > 0) return 'app'
        if (down > 0) return 'bad'
        if (app > 0) return 'app'
        return reads.some(r => r === 'defer') ? 'defer' : 'bad'
    }

    // The trip cycle reads k=1 for DOWN and up to 3 distinct owners for SUSPECT and a gateway (502/503/504) root. Backups and recovery members (not yet UP)
    // read the same way, a DOWN one or one whose reads keep deferring at most every few cycles. Off the trip cycle,
    // a 502/503/504 at an UP gateway root is read before it counts (one owner, more when it does not show the app),
    // so an app whose manifests answer stays UP.
    const readsFor = (entry, result) => {
        const k = result.verdict === VERDICT.SUSPECT || result.row === 'gateway' ? GATE_READS_SUSPECT : 1
        if (entry.gateDeferred && result.verdict === VERDICT.SUSPECT && cycle - entry.readCycle < DOWN_READ_EVERY_CYCLES) return 0
        if (entry.revalidate) return 1
        if (wouldTrip(entry) || entry.state === STATE.UNKNOWN) return k
        if (result.row === 'gateway' && entry.state === STATE.UP) return 1
        if (entry.state === STATE.RECOVERING) return 1
        if (entry.state === STATE.DOWN && cycle - entry.readCycle >= DOWN_READ_EVERY_CYCLES) return 1
        return 0
    }

    // A baseline is tied to the exact answer it was taken from (row, status and fingerprint). When it expires
    // the next HTTP-level failure is read again at once.
    const onBaseline = (entry, result) => {
        const b = entry.baseline
        if (!b) return false
        if (b.until <= now() || cycle > b.untilCycle) {
            entry.baseline = null
            entry.revalidate = true
            return false
        }
        return b.row === result.row && b.status === (result.status ?? null) && b.fingerprint === (result.fingerprint ?? null)
    }

    const baselineFor = (entry, result) => {
        const base = { row: result.row, status: result.status ?? null, fingerprint: result.fingerprint ?? null }
        if (BASELINE_ROWS.has(result.row)) return { ...base, until: now() + BASELINE_MS, untilCycle: Infinity }
        if (result.row === 'traefik-404' && entry.target.kind === 'root') return { ...base, until: Infinity, untilCycle: cycle + DOWN_READ_EVERY_CYCLES }
        return null
    }

    const isTransportClass = (entry, result) => !!result?.transport && entry.target.kind !== 'custom'
    // What the breaker counts, on every path into its sample (on-time, late and carried): never a custom check,
    // and not a target already down before the cycle (judged with the batch, but it says nothing about our egress).
    const counted = (entry) => entry.target.kind !== 'custom' && !downAtStart.has(entry)

    const joinBatch = (entry, result, fresh) => {
        transportBatch.set(entry, { result, fresh })
    }

    // A result that cannot be judged this cycle: a transport result joins the next cycle's batch, any other one
    // is carried into the next cycle as its ping result.
    const dropResult = (entry, result, evalCycle) => {
        if (evalCycle === cycle) stats.overdue++
        else stats.stale++
        if (isTransportClass(entry, result)) entry.lateResult = result
        else entry.carry = { result, cycle: evalCycle }
        return entry
    }

    const verdictOf = (entry, result) => {
        let outcome = outcomeOf(result.verdict)
        if (result.resolver) {
            entry.resolverStreak++
            // The resolver grace spends the target's suppression budget like any other deferral.
            if (entry.resolverStreak >= RESOLVER_REPEAT_CYCLES || entry.suppressed >= SUPPRESS_MAX) {
                outcome = 'bad'
            } else {
                entry.suppressed++
                outcome = 'defer'
            }
        } else {
            entry.resolverStreak = 0
        }
        return outcome
    }

    // One step per target per cycle. A conclusion that lands after its own cycle ended counts for the cycle
    // running now, or, between cycles, is carried into the next one; it is never restarted.
    const step = (entry, outcome, evalCycle) => {
        let at = evalCycle
        if (!inCycle) {
            entry.conclusion = { outcome }
            stats.carriedConclusions++
            return entry
        }
        if (evalCycle !== cycle) at = cycle
        if (entry.steppedCycle === at) return entry
        // Real non-failing evidence for the target refills its suppression budget.
        if (outcome === 'good') entry.suppressed = 0
        entry.steppedCycle = at
        entry.judgedCycle = at
        stepState(entry, outcome)
        return entry
    }

    // The rest of one verdict: HTTP-level evidence (SUSPECT, or DOWN of strength H, including a hung root page)
    // is read before it counts, then the target moves one step. The read always runs with at least
    // GATE_MIN_MS; when it outlasts the cycle its conclusion is carried (see step), so the target converges.
    const conclude = async (entry, result, outcome, evalCycle, due) => {
        const gated = outcome === 'bad' && (result.verdict === VERDICT.SUSPECT || result.strength === STRENGTH.H)
        if (gated && onBaseline(entry, result)) {
            outcome = 'good'
        } else if (gated) {
            const k = readManifest && entry.target.kind !== 'custom' ? readsFor(entry, result) : 0
            const confirmable = result.verdict !== VERDICT.SUSPECT
            if (k > 0) {
                const budgetMs = Math.max(Math.min(GATE_MIN_MS, gateBudgetMs), Math.min(gateBudgetMs, due - Date.now() - 100))
                outcome = await gate(entry, result, k, budgetMs)
                // Spaced re-reads are for SUSPECT pings whose reads said nothing; a rate-limited read on an
                // HTTP-level DOWN is read again next cycle.
                if (outcome === 'defer' && result.verdict === VERDICT.SUSPECT) entry.gateDeferred = true
                // Reads that decided nothing (queued, rate limited, challenged) spend the budget for H failures;
                // once it is spent the failure commits.
                if (outcome === 'defer' && confirmable) {
                    if (entry.suppressed >= SUPPRESS_MAX) outcome = 'bad'
                    else entry.suppressed++
                }
                if (outcome === 'app') {
                    entry.baseline = baselineFor(entry, result)
                    outcome = 'good'
                }
            } else if (readManifest && result.verdict === VERDICT.SUSPECT && (entry.gateDeferred || entry.state === STATE.DOWN)) {
                outcome = 'defer'
            }
        }
        if (outcome === 'good' || outcome === 'bad') entry.gateDeferred = false
        return step(entry, outcome, evalCycle)
    }

    const applyTransport = (entry, result, decision, evalCycle, due) => {
        if (entry.steppedCycle === evalCycle) return Promise.resolve(entry)
        let outcome = verdictOf(entry, result)
        // A tripped breaker defers the failure; while pings still running could trip it, a failure that would
        // commit DOWN waits for them (steps short of DOWN still apply). Majority uncertainty holds any transport
        // failure; resolver-only uncertainty holds only a target whose own result is a resolver failure. All of
        // it spends the target's one suppression budget; once spent the failure commits regardless of the breaker.
        if (outcome === 'bad' && entry.suppressed < SUPPRESS_MAX) {
            if (decision.trips && decision.applies) {
                entry.suppressed++
                outcome = 'defer'
            } else if ((decision.undetermined || (decision.undeterminedResolver && result.resolver)) && wouldTrip(entry)) {
                entry.suppressed++
                stats.heldDown++
                return Promise.resolve(entry)
            }
        }
        return conclude(entry, result, outcome, evalCycle, due)
    }

    // One trip per cycle at most: it counts toward the 5-cycle bound and logs on the first.
    const trip = (breaker) => {
        breakerRun++
        const applies = breakerRun <= BREAKER_MAX_CYCLES
        if (breakerRun === 1) {
            stats.breakerTrips++
            log?.warn?.({ category: 'Autopilot', fmt: 'ap.egress_breaker', failed: breaker.failed, domains: breaker.domains, resolver: 'resolver errors' }, `Egress breaker tripped: ${breaker.failed} of ${breaker.domains} domains failed at transport level (resolver errors on ${breaker.resolver}); transport failures are deferred this cycle.`)
        } else if (!applies && !breakerHeldLogged) {
            breakerHeldLogged = true
            log?.warn?.({ category: 'Autopilot' }, `Egress breaker held for ${BREAKER_MAX_CYCLES} cycles; transport verdicts apply again.`)
        }
        return { ...breaker, applies }
    }

    // The judgment point: one breaker decision for this batch (every transport result that landed since the
    // last judgment, on-time and late alike). Evidence has a bounded age: a counted target of the cycle counts
    // with what was observed this cycle, or its late result from the last cycle, never an older cached result.
    // A target whose ping is still running is unresolved. When the unresolved could swing the breaker either
    // way, the decision is undetermined: no trip yet, and DOWN commits wait within the target's suppression
    // budget (see applyTransport). A tripped
    // breaker defers the whole batch; otherwise each result is judged normally. Batch results whose evaluation
    // is not waiting (late results from the last cycle) are judged here.
    // At worst an unresolved target is a failure of any kind. The two breaker rules are checked on both bounds
    // separately: half of 4+ domains (any transport failure) and EAI_AGAIN on 3+ (resolver failures).
    const UNRESOLVED_DOWN = { verdict: VERDICT.DOWN, transport: true, resolver: false }
    const UNRESOLVED_RESOLVER = { verdict: VERDICT.DOWN, transport: true, resolver: true }
    const UNRESOLVED_UP = { verdict: VERDICT.UP, transport: false }
    const judge = (evalCycle) => {
        const sample = []
        const unresolved = []
        for (const entry of entries.values()) {
            if (entry.evalCycle !== evalCycle || !counted(entry)) continue
            const domain = domainOf(entry.target)
            const result = transportBatch.get(entry)?.result ?? (entry.landedCycle === evalCycle ? entry.last : null)
            if (result) sample.push({ domain, result })
            else unresolved.push(domain)
        }
        const best = breakerTrips([...sample, ...unresolved.map(domain => ({ domain, result: UNRESOLVED_UP }))])
        const worstMajority = breakerTrips([...sample, ...unresolved.map(domain => ({ domain, result: UNRESOLVED_DOWN }))])
        const worstResolver = breakerTrips([...sample, ...unresolved.map(domain => ({ domain, result: UNRESOLVED_RESOLVER }))])
        let decision
        if (best.trips) {
            decision = trip(best)
        } else if (worstMajority.trips) {
            decision = { ...best, trips: false, applies: false, undetermined: true }
        } else if (worstResolver.trips) {
            decision = { ...best, trips: false, applies: false, undeterminedResolver: true }
        } else {
            breakerRun = 0
            breakerHeldLogged = false
            decision = { ...best, applies: false }
        }
        const due = deadlineAt
        for (const [entry, item] of transportBatch) {
            if (item.fresh) continue
            // The target's own evaluation awaits this verdict (including its backup read) before it settles.
            entry.carriedVerdict = { cycle: evalCycle, promise: applyTransport(entry, item.result, decision, evalCycle, due).catch(() => entry) }
        }
        return decision
    }

    // A target settles only once the verdict judged for it from the last cycle's late result is done.
    const awaitCarried = async (entry, evalCycle) => {
        const carried = entry.carriedVerdict
        if (!carried) return entry
        if (carried.cycle === evalCycle) await carried.promise
        if (entry.carriedVerdict === carried) entry.carriedVerdict = null
        return entry
    }

    // One evaluation per target per cycle. Transport verdicts are never applied one by one: they wait for the
    // cycle's judgment point, and a result landing after it joins the next cycle's batch. Everything else is
    // judged as it lands.
    const runCycleEvaluation = async (entry, evalCycle) => {
        const due = deadlineAt
        const live = () => evalCycle === cycle && inCycle && Date.now() <= due
        const waiting = judged ? null : pending
        waiting?.add()
        let result
        try {
            result = await pingForCycle(entry)
        } catch (err) {
            waiting?.done()
            throw err
        }
        if (!live()) {
            waiting?.done()
            dropResult(entry, result, evalCycle)
            return awaitCarried(entry, evalCycle)
        }
        entry.landedCycle = evalCycle
        record(entry, result)
        if (isTransportClass(entry, result)) {
            if (judged) {
                waiting?.done()
                stats.lateTransport++
                entry.lateResult = result
                return awaitCarried(entry, evalCycle)
            }
            joinBatch(entry, result, true)
            const decision = judgment
            waiting?.done()
            const verdictOfBatch = await decision
            // A judgment fired by endCycle() still belongs to this cycle.
            if (evalCycle !== cycle || Date.now() > due) return dropResult(entry, result, evalCycle)
            return applyTransport(entry, result, verdictOfBatch, evalCycle, due)
        }
        // A fresh answer replaces a late transport result from the last cycle.
        transportBatch.delete(entry)
        waiting?.done()
        await conclude(entry, result, verdictOf(entry, result), evalCycle, due)
        return awaitCarried(entry, evalCycle)
    }

    const evaluate = (entry) => {
        if (inCycle) {
            if (entry.evalCycle === cycle) return entry.evaluation
            // Captured before the run: a late completion of a replaced evaluation must never mark the
            // one that superseded it settled.
            const evalCycle = cycle
            const evaluation = runCycleEvaluation(entry, evalCycle).catch(() => entry)
            entry.evalCycle = evalCycle
            entry.evaluation = evaluation
            evaluation.then(() => { if (entry.evaluation === evaluation) entry.evalSettledCycle = evalCycle })
            return evaluation
        }
        if (entry.last && now() - entry.last.at < CACHED_VERDICT_MS) return Promise.resolve(entry)
        return pingOnce(entry).then((result) => { record(entry, result); return entry }, () => entry)
    }

    const statusOf = (entry) => ({
        key: entry.key,
        state: entry.state,
        goodStreak: entry.goodStreak,
        badStreak: entry.badStreak,
        verdict: entry.last?.verdict ?? null,
        row: entry.last?.row ?? null,
        status: entry.last?.status ?? null,
        strength: entry.last?.strength ?? null,
        transport: !!entry.last?.transport,
        latencyMs: entry.lastGood?.latencyMs ?? null,
    })

    // Rules wait for a target at most until the cycle's ping deadline; past it they read the state as is.
    // Only a check whose evaluation is still in flight has to race the deadline; a settled one no longer
    // registers on it. The status is read when each caller's promise settles, never cached.
    const settle = (entry) => {
        const evaluation = evaluate(entry)
        if (inCycle && !(entry.evalCycle === cycle && entry.evalSettledCycle === cycle)) return Promise.race([evaluation, deadline]).then(() => statusOf(entry))
        return evaluation.then(() => statusOf(entry))
    }

    const invalid = { key: null, state: STATE.DOWN, goodStreak: 0, badStreak: FAIL_STREAK, verdict: VERDICT.DOWN, row: 'invalid-url', strength: STRENGTH.T, transport: true, latencyMs: null }

    const check = (url, { owner = null, inUse = false } = {}) => {
        const target = targetFor(url)
        if (!target) return Promise.resolve(invalid)
        const entry = entryFor(target)
        remember(entry, url, owner, inUse)
        return settle(entry)
    }

    const checkCustom = (url) => {
        const target = customTargetFor(url)
        if (!target) return Promise.resolve(invalid)
        return settle(entryFor(target))
    }

    const peek = (url) => {
        const target = targetFor(url)
        const entry = target ? entries.get(target.key) : null
        return entry ? statusOf(entry) : null
    }

    // Starts the cycle's ping pipeline for every recently referenced target, the ones judged longest ago
    // first. Rules read the latest verdict. The judgment point comes when every ping started this cycle has
    // settled, or at the cutoff, whichever is first.
    const beginCycle = () => {
        cycle++
        inCycle = true
        const started = now()
        deadlineAt = Date.now() + pingBudgetMs
        const judgmentDelayMs = Math.max(0, pingBudgetMs - Math.min(1000, Math.floor(pingBudgetMs / 10)))
        judgmentCutoffAt = Date.now() + judgmentDelayMs
        let timer = null
        deadline = new Promise(resolve => { timer = setTimeout(resolve, pingBudgetMs) })
        deadline.timer = timer
        const evalCycle = cycle
        judged = false
        transportBatch = new Map()
        downAtStart = new Set([...entries.values()].filter(e => e.state === STATE.DOWN || e.state === STATE.RECOVERING))
        let resolveJudgment
        judgment = new Promise(resolve => { resolveJudgment = resolve })
        let judgeTimer = null
        // Bound to this cycle: a timer or immediate left over from it can never fire a later cycle's judgment.
        const fire = () => {
            if (judged || evalCycle !== cycle) return
            judged = true
            clearTimeout(judgeTimer)
            resolveJudgment(judge(evalCycle))
        }
        fireJudgment = fire
        judgeTimer = setTimeout(fire, judgmentDelayMs)
        let waitingCount = 0
        pending = {
            add: () => { waitingCount++ },
            done: () => {
                waitingCount--
                if (waitingCount === 0) setImmediate(() => { if (waitingCount === 0) fire() })
            },
        }
        // Conclusions that landed between cycles are this cycle's step for their target.
        for (const entry of entries.values()) {
            if (!entry.conclusion) continue
            const { outcome } = entry.conclusion
            entry.conclusion = null
            step(entry, outcome, cycle)
        }
        // Transport results that landed after the last judgment join this batch.
        for (const entry of entries.values()) {
            if (!entry.lateResult) continue
            joinBatch(entry, entry.lateResult, false)
            entry.lateResult = null
        }
        const batch = [...entries.values()]
            .filter(e => started - e.referencedAt <= ACTIVE_REFERENCE_MS)
            .sort((a, b) => a.judgedCycle - b.judgedCycle)
        for (const entry of batch) evaluate(entry)
    }

    const endCycle = () => {
        // A cycle that ends before its judgment point judges what it has; results then join the next batch.
        fireJudgment()
        inCycle = false
        pending = null
        clearTimeout(deadline.timer)
        deadline = Promise.resolve()
        deadlineAt = Infinity
        judgmentCutoffAt = Infinity
        evict()
    }

    return {
        check, checkCustom, peek, beginCycle, endCycle,
        size: () => entries.size,
        bytes: () => totalBytes,
        // Counters since the last call, for the cycle summary line.
        takeStats: () => {
            const out = { ...stats, breakerRun }
            for (const k of Object.keys(stats)) stats[k] = 0
            return out
        },
    }
}
