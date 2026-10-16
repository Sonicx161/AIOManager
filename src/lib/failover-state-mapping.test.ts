import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { didActiveTierChange } from './failover-state-mapping.ts'

// Nuvio "Swap & Hide" convergence (min-max): when the autopilot engine enforces a tier
// swap server-side, the client poll path must (a) detect the tier change against its
// local copy and (b) reconcile as a pure consumer — apply the enforced flags locally,
// never push the local list back to the platform. The tests below lock the swap
// detector's decision matrix plus the failoverStore wiring via source contracts (same
// pattern as canonical-split-brain-delivery.test.ts).

const here = dirname(fileURLToPath(import.meta.url))

test('didActiveTierChange decision matrix (the convergence trigger)', () => {
    const tier1 = 'https://foo.example/manifest.json'
    const tier2 = 'https://bar.example/manifest.json'

    // No server statement: never a swap, nothing to converge to.
    assert.equal(didActiveTierChange(tier1, ''), false)
    assert.equal(didActiveTierChange(tier1, undefined), false)

    // Same tier under cosmetics the normalizer erases: not a swap.
    assert.equal(didActiveTierChange(tier1, 'https://foo.example/'), false)
    assert.equal(didActiveTierChange(tier1, 'https://FOO.example'), false)
    assert.equal(didActiveTierChange(tier1, 'stremio://foo.example'), false)

    // First enforcement against an empty local copy is a swap.
    assert.equal(didActiveTierChange(undefined, tier2), true)
    assert.equal(didActiveTierChange('', tier2), true)

    // The actual Tier 1 -> Tier 2 event.
    assert.equal(didActiveTierChange(tier1, tier2), true)

    // Plain normalizeAddonUrl keeps query strings, so a re-pointed config URL counts.
    assert.equal(didActiveTierChange(tier1, `${tier1}?v=2`), true)
})

function readSrc(rel: string): string {
    return readFileSync(join(here, '..', rel), 'utf8')
}

function sliceConst(src: string, marker: string): string {
    const start = src.indexOf(marker)
    assert.ok(start >= 0, `missing source marker: ${marker}`)
    const nextConst = src.indexOf('\nconst ', start + marker.length)
    return nextConst >= 0 ? src.slice(start, nextConst) : src.slice(start)
}

test('poll path reconciles as a consumer, not a writer', () => {
    const src = readSrc('store/failoverStore.ts')

    // The poll-driven reconcile (pullServerState) applies the enforced state with
    // localOnly so toggleAddonEnabled runs silent — no backgroundSync, no
    // pushToConnections, no intermediate "no tier active" push to Nuvio.
    assert.match(src, /reconcileAccountAddonsWithActiveRule\(updatedRules\[ruleIndex\], \{ localOnly: true \}\)/)

    // The boot/sync consumer path (syncServerState) is localOnly too.
    assert.match(src, /\(rule\) => reconcileAccountAddonsWithActiveRule\(rule, \{ localOnly: true \}\)/)

    // localOnly maps straight onto toggleAddonEnabled's silent flag (4th arg).
    const reconcileBody = sliceConst(src, 'const reconcileAccountAddonsWithActiveRule')
    assert.match(reconcileBody, /opts\?\.localOnly === true,/)

    // The swap detector drives the poll-path branch.
    assert.match(src, /if \(didActiveTierChange\(localRule\.activeUrl, nextActiveUrl\)\)/)
    assert.match(src, /import \{ didActiveTierChange, rebuildRuleFromServerState, stripUndefinedRuleFields \} from '@\/lib\/failover-state-mapping'/)

    // Manual user actions stay writers: addRule/updateRule/toggleRuleActive reconcile
    // without localOnly so intentional edits still propagate to the platform.
    assert.match(src, /const reconciled = await reconcileAccountAddonsWithActiveRule\(newRule\)/)
    assert.equal((src.match(/await reconcileAccountAddonsWithActiveRule\(rule\)/g) || []).length, 2)
})

test('tab focus pokes the existing poll loop — no new polling timer', () => {
    const src = readSrc('store/failoverStore.ts')
    const handler = sliceConst(src, 'const handleFocusPulse')

    // Registered with the automation lifecycle and cleaned up on stop.
    assert.match(src, /document\.addEventListener\('visibilitychange', handleFocusPulse\)/)
    assert.match(src, /document\.removeEventListener\('visibilitychange', handleFocusPulse\)/)
    const startIdx = src.indexOf('startAutomation: () => {')
    const stopIdx = src.indexOf('stopAutomation: () => {')
    assert.ok(startIdx >= 0 && stopIdx > startIdx, 'missing automation lifecycle')
    assert.ok(src.slice(startIdx, stopIdx).includes('registerFocusPulse()'), 'startAutomation must register the focus pulse')
    assert.ok(src.slice(stopIdx).includes('unregisterFocusPulse()'), 'stopAutomation must unregister the focus pulse')

    // Convergence on focus reuses pulse() only; its internal guards (_isPulling, vault
    // lock, auth) decide whether a pull actually happens.
    assert.match(handler, /void state\.pulse\(\)/)

    // The handler must not grow its own timers or bypass pulse's gating with the heavy
    // full-sync / direct pull paths.
    assert.ok(!handler.includes('setTimeout'), 'focus handler must not create timers')
    assert.ok(!handler.includes('pullServerState'), 'focus handler defers to pulse gating')
    assert.ok(!handler.includes('syncAllAccounts'), 'focus handler must not trigger the heavy full sync')
})
