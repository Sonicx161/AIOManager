import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { needsCredentialHeal } from './credential-heal.ts'
import { sourceFunction } from '../../test-support/source-harness.mjs'



// defaults never persisted it — external Hydra writes stalled in the canonical store
// until a client synced, and the split-brain warning never cleared. The fix heals
// after every confirmed push. Two layers here: the pure decision matrix for the heal
// gate, plus static source-contract locks over the wiring (same pattern as
// canonical-split-brain-delivery.test.ts) so a revert fails this suite.

const here = dirname(fileURLToPath(import.meta.url))

test('needsCredentialHeal decision matrix (the heal gate)', () => {
    const keyed = { id: 'acc-1', hasClientStremioKey: true }
    const unkeyed = { id: 'acc-2', hasClientStremioKey: false }

    // Nothing to upload when there are no accounts at all.
    assert.equal(needsCredentialHeal([], []), false)
    assert.equal(needsCredentialHeal(['acc-1'], []), false)

    // Never learned the server set (null): one-shot best-effort upload is fail-safe.
    assert.equal(needsCredentialHeal(null, [keyed]), true)
    assert.equal(needsCredentialHeal(null, [unkeyed]), false)

    // Server set known: heal only accounts with a client key the set does not cover.
    assert.equal(needsCredentialHeal([], [keyed]), true, 'the split-brain shape itself')
    assert.equal(needsCredentialHeal(['acc-2'], [keyed]), true)
    assert.equal(needsCredentialHeal(['acc-1'], [keyed]), false, 'healed steady state')
    assert.equal(needsCredentialHeal([], [unkeyed]), false, 'no client key: nothing uploadable')
    assert.equal(needsCredentialHeal(['acc-1'], [keyed, unkeyed]), false)
})

function readSrc(rel: string): string {
    return readFileSync(join(here, '..', rel), 'utf8')
}

test('the credential core is engine-free and the activity-linked name delegates to it', () => {
    const src = readSrc('lib/activity-server.ts')

    assert.match(src, /export async function syncCredentialsToServer\(\): Promise<number> \{/)

    const coreStart = src.indexOf('export async function syncCredentialsToServer')
    const coreEnd = src.indexOf('\nexport ', coreStart + 1)
    const core = src.slice(coreStart, coreEnd)
    assert.ok(core.length > 0, 'core function body found')
    assert.ok(!core.includes('engineEnabled'), 'the credential core must not check the activity engine')
    assert.ok(core.includes('encryptionKey'), 'the core still requires the vault key to decrypt local auth keys')
    assert.match(src, /export async function pushCredentialsToServer\(\): Promise<number> \{\s*return syncCredentialsToServer\(\)\s*\}/)
})

test('a confirmed push fires the heal when the server set shows an account missing', () => {
    const src = readSrc('store/syncStore.ts')

    // The heal rides the confirmed-push path, after the response adoption (so the
    // learned set and the republish machinery run first), and keys off the response's
    // authoritative serverStremioCredentialedAccounts.
    const adoptedAt = src.indexOf('adoptPushResponseCredentials(forceCanonicalRepublish, resData.serverStremioCredentialedAccounts)')
    const healAt = src.indexOf('needsCredentialHeal(serverCredentialedIds')
    assert.ok(adoptedAt >= 0, 'push success path adopts the server-credentialed set')
    assert.ok(healAt > adoptedAt, 'the heal check runs after the adoption')

    assert.match(src, /import \{ needsCredentialHeal \} from '@\/lib\/credential-heal'/)
    assert.match(src, /Array\.isArray\(resData\.serverStremioCredentialedAccounts\)/)
})

test('credential upload after a successful push stays fenced across an asynchronous session change', async () => {
    for (const stillCurrent of [false, true]) {
        let current = true
        let uploaded = 0
        let finishImport: (module: unknown) => void = () => {}
        const imported = new Promise(resolve => { finishImport = resolve })
        const heal = sourceFunction(join(here, '../store/syncStore.ts'), 'if:needsCredentialHeal', {
            needsCredentialHeal, serverCredentialedIds: [],
            useAccountStore: { getState: () => ({ accounts: [{ id: 'account' }] }) },
            getStremioAuthKey: () => 'key', pushCurrent: () => current,
            __import: () => imported,
        })
        heal()
        current = stillCurrent
        finishImport({ syncCredentialsToServer: async () => { uploaded++ } })
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(uploaded, stillCurrent ? 1 : 0)
    }
})
