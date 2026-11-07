/**
 * Structural sharing for store writes: keep the previous object identity when
 * incoming data is deep-equal to what is stored, so memoized subscribers skip
 * re-rendering and identical durable writes can be skipped.
 *
 * Plain objects, arrays and dates are compared structurally (same contract as
 * activity-structural-sharing). Anything else (class instances, Maps, Sets) is
 * treated as changed rather than guessed equal, so a shared identity is only
 * ever returned for values that really are interchangeable.
 */

function sameValue(previous: unknown, next: unknown, depth: number): boolean {
    if (Object.is(previous, next)) return true
    if (previous instanceof Date && next instanceof Date) return Object.is(previous.getTime(), next.getTime())
    if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return false
    // Cyclic or pathological nesting is treated as changed rather than guessed
    // equal, so the comparison always terminates.
    if (depth >= MAX_COMPARE_DEPTH) return false
    const prototype = Object.getPrototypeOf(previous)
    if (prototype !== Object.getPrototypeOf(next)) return false
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(previous)) return false
    const keys = Reflect.ownKeys(previous)
    if (keys.length !== Reflect.ownKeys(next).length) return false
    return keys.every(key => Object.prototype.hasOwnProperty.call(next, key)
        && sameValue((previous as Record<PropertyKey, unknown>)[key], (next as Record<PropertyKey, unknown>)[key], depth + 1))
}

// Deep-equal trees deeper than this (or cyclic ones) compare as changed; real
// store data nests a handful of levels at most.
const MAX_COMPARE_DEPTH = 64

/**
 * Return `previous` when it is deep-equal to `next` (keeping identity so
 * subscribers and storage dedup see "nothing changed"); otherwise return
 * `next` untouched. Never mutates either argument.
 */
export function reuseUnchanged<T>(previous: T, next: T): T {
    if (previous === next) return previous
    if (Array.isArray(previous) && Array.isArray(next)) {
        if (previous.length !== next.length) return next
        for (let i = 0; i < next.length; i++) {
            if (!sameValue(previous[i], next[i], 1)) return next
        }
        return previous
    }
    if (previous !== null && next !== null && typeof previous === 'object' && typeof next === 'object') {
        const prototype = Object.getPrototypeOf(previous)
        if (prototype === Object.getPrototypeOf(next) && (prototype === Object.prototype || prototype === null)) {
            if (sameValue(previous, next, 0)) return previous
            return next
        }
    }
    if (sameValue(previous, next, 0)) return previous
    return next
}
