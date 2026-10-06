// Account-wide chain flags and the write guard that protects them.
//
// An account runs one autopilot rule per addon chain, and every rule stores the ACCOUNT's whole
// addon list. Deriving only the writer's own chain therefore publishes a stale copy of every
// sibling chain, and the last writer wins - which silently reverts a sibling's failover. These
// tests pin the account-wide derivation, the two-writers-agree property that fixes it, and the
// guard that refuses any write which would leave a managed chain without its active member.
process.env.ENCRYPTION_KEY = 'test-encryption-key-32bytes-long!!'

import test from 'node:test'
import assert from 'node:assert/strict'

import { applyAccountChainFlags, chainGuardFailure } from '../autopilot/one-active.js'

const AIOS_PRIMARY = 'https://primary-a.example/stremio/aios/manifest.json'
const AIOS_BACKUP = 'https://backup-a.example/stremio/aios/manifest.json'
const AIOM_PRIMARY = 'https://primary-b.example/stremio/aiom/manifest.json'
const AIOM_BACKUP = 'https://backup-b.example/stremio/aiom/manifest.json'

const AIOS_CHAIN = { urls: [AIOS_PRIMARY, AIOS_BACKUP], target: AIOS_BACKUP }
const AIOM_CHAIN = { urls: [AIOM_PRIMARY, AIOM_BACKUP], target: AIOM_BACKUP }

// A platform list: [url, enabled, manifest id]
const platformList = (...rows) => rows.map(([url, enabled, id]) => ({
    transportUrl: url,
    flags: { enabled },
    manifest: { id },
}))

const enabledOf = (list, url) => list.find(a => a.transportUrl === url)?.flags?.enabled

// The guard reads an enabled-only list (the caller's canonical list), so membership is enabledness.
const enabledList = (...urls) => urls.map(url => ({ transportUrl: url }))

test('derives the flags of a chain the writer does not own', () => {
    // The writer owns aiostreams (already on its backup) and carries a stale aiometadata entry.
    const candidate = platformList(
        [AIOS_BACKUP, true, 'aios-backup'],
        [AIOS_PRIMARY, false, 'aios-primary'],
        [AIOM_PRIMARY, true, 'aiom-primary'],
        [AIOM_BACKUP, false, 'aiom-backup'],
    )

    const { list, skipped } = applyAccountChainFlags(candidate, [AIOM_CHAIN])

    assert.equal(enabledOf(list, AIOM_BACKUP), true, 'sibling target is enabled')
    assert.equal(enabledOf(list, AIOM_PRIMARY), false, 'stale sibling member is disabled')
    assert.equal(enabledOf(list, AIOS_BACKUP), true, 'the writer\'s own chain is untouched')
    assert.equal(skipped.length, 0)
})

test('two writers holding stale copies of each other converge instead of reverting', () => {
    // Each rule has its own chain right and the sibling wrong - the state the clobber produced.
    const writerA = platformList(
        [AIOS_BACKUP, true, 'aios-backup'],
        [AIOS_PRIMARY, false, 'aios-primary'],
        [AIOM_PRIMARY, true, 'aiom-primary'],
        [AIOM_BACKUP, false, 'aiom-backup'],
    )
    const writerB = platformList(
        [AIOS_PRIMARY, true, 'aios-primary'],
        [AIOS_BACKUP, false, 'aios-backup'],
        [AIOM_BACKUP, true, 'aiom-backup'],
        [AIOM_PRIMARY, false, 'aiom-primary'],
    )

    // Both chains are on their backups right now; each writer derives the other's chain.
    const fromA = applyAccountChainFlags(writerA, [AIOM_CHAIN]).list
    const fromB = applyAccountChainFlags(writerB, [AIOS_CHAIN]).list

    for (const url of [AIOS_PRIMARY, AIOS_BACKUP, AIOM_PRIMARY, AIOM_BACKUP]) {
        assert.equal(enabledOf(fromA, url), enabledOf(fromB, url), `both writers agree on ${url}`)
    }
    assert.equal(enabledOf(fromA, AIOS_BACKUP), true, 'aiostreams stays on its backup')
    assert.equal(enabledOf(fromB, AIOM_BACKUP), true, 'aiometadata stays on its backup')
})

test('reports a chain it cannot express instead of disabling what it can see', () => {
    const candidate = platformList(
        [AIOS_PRIMARY, true, 'aios-primary'],
        [AIOS_BACKUP, false, 'aios-backup'],
    )

    const { list, skipped } = applyAccountChainFlags(candidate, [AIOM_CHAIN])

    assert.equal(skipped.length, 1, 'the caller must fall back to the platform for this chain')
    assert.equal(skipped[0].target, AIOM_BACKUP)
    assert.deepEqual(list, candidate, 'nothing was disabled on a guess')
})

test('ignores malformed chain descriptors and leaves non-chain addons alone', () => {
    const candidate = platformList(
        [AIOM_PRIMARY, true, 'aiom-primary'],
        ['https://subtitles.example/manifest.json', true, 'subs'],
    )
    const before = JSON.parse(JSON.stringify(candidate))

    applyAccountChainFlags(candidate, [null, {}, { urls: [], target: AIOM_BACKUP }, { urls: [AIOM_PRIMARY], target: '' }])

    assert.deepEqual(candidate, before)
})

test('guard passes when every managed chain has its active member', () => {
    const reason = chainGuardFailure(
        enabledList(AIOS_BACKUP, AIOM_BACKUP),
        [AIOS_CHAIN, AIOM_CHAIN],
    )

    assert.equal(reason, null)
})

test('guard refuses the clobbered state: a managed chain lost its active member', () => {
    // aiostreams is on its backup, but the candidate list carries aiometadata's PRIMARY while
    // that chain's target is the backup - the exact list the two-rule clobber used to write.
    const reason = chainGuardFailure(
        enabledList(AIOS_BACKUP, AIOM_PRIMARY),
        [AIOS_CHAIN, AIOM_CHAIN],
    )

    assert.match(String(reason), /survivors 1, active present false/)
})

test('guard refuses a chain with no enabled members', () => {
    const reason = chainGuardFailure(enabledList(AIOS_BACKUP), [AIOS_CHAIN, AIOM_CHAIN])

    assert.match(String(reason), /2 member\(s\), survivors 0/)
})

test('guard still allows a chain with several enabled members, which is what the engine repairs', () => {
    const reason = chainGuardFailure(
        enabledList(AIOS_PRIMARY, AIOS_BACKUP, AIOM_BACKUP),
        [AIOS_CHAIN, AIOM_CHAIN],
    )

    assert.equal(reason, null)
})

test('guard no-ops without managed chains', () => {
    assert.equal(chainGuardFailure(enabledList(AIOS_PRIMARY), []), null)
    assert.equal(chainGuardFailure(enabledList(AIOS_PRIMARY), undefined), null)
})
