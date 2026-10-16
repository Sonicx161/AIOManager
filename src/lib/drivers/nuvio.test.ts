import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveProfileIndexWith } from './nuvio-profile.ts'

const UUID = 'profile-uuid-from-import'

let pullBehavior: () => Promise<Array<Record<string, unknown>>>

beforeEach(() => {
    pullBehavior = async () => []
})

const enumerated = (rows: Array<Record<string, unknown>>) => async () => rows
const rpcMissing = () => Promise.reject(new Error('function sync_pull_profiles does not exist'))

test('self-hosted backend without the profiles RPC falls back to the primary (the #59 fix)', async () => {
    pullBehavior = rpcMissing
    const r = await resolveProfileIndexWith(pullBehavior, UUID, { strict: true })
    assert.equal(r.index, 1)
    assert.equal(r.profilesRpcFailed, true)
})

test('non-strict resolution on an RPC-missing backend also lands on the primary', async () => {
    pullBehavior = rpcMissing
    const r = await resolveProfileIndexWith(pullBehavior, UUID)
    assert.equal(r.index, 1)
})

test('enumerated profiles without the stored id refuse the write (wrong-target protection intact)', async () => {
    pullBehavior = enumerated([{ id: 'someone-elses-profile', profile_index: 1 }])
    await assert.rejects(
        resolveProfileIndexWith(pullBehavior, UUID, { strict: true }),
        /refusing to fall back/
    )
})

test('enumerated profiles with the stored id resolve to its index', async () => {
    pullBehavior = enumerated([{ id: UUID, profile_index: 3 }])
    const r = await resolveProfileIndexWith(pullBehavior, UUID, { strict: true })
    assert.equal(r.index, 3)
    assert.equal(r.profilesRpcFailed, false)
})

test('numeric profile ids are used directly without a pull', async () => {
    let pulled = false
    pullBehavior = async () => { pulled = true; return [{ id: 'x', profile_index: 1 }] }
    const r = await resolveProfileIndexWith(pullBehavior, 7, { strict: true })
    assert.equal(r.index, 7)
    assert.equal(pulled, false)
})

test('the server driver mirrors the same RPC-missing fallback', async () => {
    const src = readFileSync(new URL('../../../server/providers/nuvio-driver.js', import.meta.url), 'utf8')
    assert.match(src, /failed: true/)
    assert.match(src, /opts\.strict && stringId && !profilesRpcFailed/)
})

test('the client driver consumes the shared resolver (no inline copy left behind)', async () => {
    const src = readFileSync(new URL('./nuvio.ts', import.meta.url), 'utf8')
    assert.match(src, /resolveProfileIndexWith/)
    assert.doesNotMatch(src, /refusing to fall back to the primary profile/)
})
