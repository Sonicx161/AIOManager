import test from 'node:test'
import assert from 'node:assert/strict'
import localforage from 'localforage'
import {
    ANON_WORKSPACE_ID,
    LEGACY_MIGRATED_FLAG,
    WORKSPACE_DB_PREFIX,
    getActiveWorkspaceId,
    initWorkspacePersistence,
    installWorkspaceForwarders,
    migrateLegacyIntoWorkspace,
    resolveWorkspaceIdFromSnapshot,
    sanitizeWorkspaceId,
    setActiveWorkspace,
    setWorkspaceStoreFactory,
    workspaceDbName,
    type AsyncKV,
} from './workspace-persistence.ts'

function memoryKv(seed: Record<string, unknown> = {}): AsyncKV & { dump(): Record<string, unknown> } {
    const data = new Map<string, unknown>(Object.entries(seed))
    return {
        async getItem<T = unknown>(key: string): Promise<T | null> {
            return (data.has(key) ? data.get(key) : null) as T | null
        },
        async setItem(key: string, value: unknown): Promise<void> { data.set(key, value) },
        async removeItem(key: string): Promise<void> { data.delete(key) },
        async keys(): Promise<string[]> { return [...data.keys()] },
        async clear(): Promise<void> { data.clear() },
        dump(): Record<string, unknown> { return Object.fromEntries(data) },
    }
}

// One fake browser: workspace backends are in-memory stores keyed by the same
// database names the app would create in IndexedDB.
const databases = new Map<string, AsyncKV & { dump(): Record<string, unknown> }>()
setWorkspaceStoreFactory(dbName => {
    const store = memoryKv()
    databases.set(dbName, store)
    return store
})
installWorkspaceForwarders()

function databaseFor(id: string): AsyncKV & { dump(): Record<string, unknown> } {
    const db = databases.get(workspaceDbName(id))
    assert.ok(db, `workspace ${id} should have a database`)
    return db
}

test('workspace database names embed the workspace id', () => {
    assert.equal(workspaceDbName('abc-123'), `${WORKSPACE_DB_PREFIX}abc-123`)
    assert.notEqual(workspaceDbName('a'), workspaceDbName('b'))
    assert.equal(workspaceDbName('weird id/chars'), `${WORKSPACE_DB_PREFIX}weird_id_chars`)
})

test('workspace ids are sanitized before they name a database', () => {
    assert.equal(sanitizeWorkspaceId('a/b:c'), 'a_b_c')
    assert.equal(sanitizeWorkspaceId(''), ANON_WORKSPACE_ID)
    assert.equal(sanitizeWorkspaceId(undefined), ANON_WORKSPACE_ID)
})

test('the persisted sync snapshot resolves the boot workspace id', () => {
    const snapshot = JSON.stringify({ state: { auth: { id: 'ws-1' } } })
    assert.equal(resolveWorkspaceIdFromSnapshot(snapshot, null), 'ws-1')
    // A corrupt primary falls through to the last-good backup.
    assert.equal(resolveWorkspaceIdFromSnapshot('{broken', snapshot), 'ws-1')
    assert.equal(resolveWorkspaceIdFromSnapshot(null, null), ANON_WORKSPACE_ID)
    assert.equal(resolveWorkspaceIdFromSnapshot(JSON.stringify({ state: { auth: { id: '' } } }), null), ANON_WORKSPACE_ID)
})

test('two users on one browser never see each other\'s namespaced data', async () => {
    setActiveWorkspace('user-a')
    await localforage.setItem('aiom-notes-index', [{ id: 'a-note' }])
    await localforage.setItem('aioman:accounts', [{ id: 'acc-a' }])

    setActiveWorkspace('user-b')
    assert.equal(await localforage.getItem('aiom-notes-index'), null, 'user B boots into an empty namespace')
    await localforage.setItem('aiom-notes-index', [{ id: 'b-note' }])

    // Switching back restores user A's view untouched by B's writes.
    setActiveWorkspace('user-a')
    assert.deepEqual(await localforage.getItem('aiom-notes-index'), [{ id: 'a-note' }])
    assert.deepEqual(await localforage.getItem('aioman:accounts'), [{ id: 'acc-a' }])

    setActiveWorkspace('user-b')
    assert.deepEqual((await localforage.keys()).sort(), ['aiom-notes-index'])
})

test('clear wipes only the active workspace', async () => {
    setActiveWorkspace('user-clear-a')
    await localforage.setItem('keep-me', 'a-data')

    setActiveWorkspace('user-clear-b')
    await localforage.setItem('burn-me', 'b-data')
    await localforage.clear()
    assert.deepEqual(await localforage.keys(), [])

    setActiveWorkspace('user-clear-a')
    assert.equal(await localforage.getItem('keep-me'), 'a-data')
})

test('legacy origin-global data migrates once into the signed-in workspace', async () => {
    const legacy = memoryKv({
        'aioman:accounts': [{ id: 'acc-1' }],
        'aiom-notes-index': [{ id: 'x-note' }],
    })
    const workspace = memoryKv()

    const copied = await migrateLegacyIntoWorkspace(legacy, workspace, 'user-x')
    assert.equal(copied, 2)
    assert.deepEqual(await workspace.getItem('aioman:accounts'), [{ id: 'acc-1' }])
    assert.deepEqual(await workspace.getItem('aiom-notes-index'), [{ id: 'x-note' }])
    // The claim records the owner and the originals are consumed, so a deleted or
    // cleared workspace cannot resurrect stale pre-migration data on re-login.
    assert.equal(await legacy.getItem('aioman:accounts'), null)
    assert.equal(await legacy.getItem('aiom-notes-index'), null)
    assert.equal(await legacy.getItem<string>(LEGACY_MIGRATED_FLAG), 'user-x')

    // A second pass copies nothing.
    assert.equal(await migrateLegacyIntoWorkspace(legacy, workspace, 'user-x'), 0)
})

test('a later user never inherits the legacy window', async () => {
    const legacy = memoryKv({
        'aioman:accounts': [{ id: 'x-only' }],
        [LEGACY_MIGRATED_FLAG]: 'user-x',
    })
    const workspaceY = memoryKv()

    assert.equal(await migrateLegacyIntoWorkspace(legacy, workspaceY, 'user-y'), 0)
    assert.deepEqual(await workspaceY.keys(), [])
    assert.deepEqual(await legacy.getItem('aioman:accounts'), [{ id: 'x-only' }])
})

test('migration never overwrites namespaced values and refills gaps after a crash', async () => {
    // Claimed by user-x but the copy never ran (simulated crash): the retry
    // completes for the same owner without clobbering what already exists.
    const legacy = memoryKv({
        'aioman:accounts': [{ id: 'acc-1' }],
        'aioman:profiles': [{ id: 'p-1' }],
        [LEGACY_MIGRATED_FLAG]: 'user-x',
    })
    const workspace = memoryKv({ 'aioman:accounts': [{ id: 'already-namespaced' }] })

    assert.equal(await migrateLegacyIntoWorkspace(legacy, workspace, 'user-x'), 1, 'only the missing key is filled')
    assert.deepEqual(await workspace.getItem('aioman:accounts'), [{ id: 'already-namespaced' }])
    assert.deepEqual(await workspace.getItem('aioman:profiles'), [{ id: 'p-1' }])
    // Both keys are now covered, so the originals are consumed.
    assert.equal(await legacy.getItem('aioman:accounts'), null)
    assert.equal(await legacy.getItem('aioman:profiles'), null)
})

test('a failed copy keeps the legacy originals for the next boot', async () => {
    const legacy = memoryKv({
        'aioman:accounts': [{ id: 'acc-1' }],
        'aioman:profiles': [{ id: 'p-1' }],
    })
    const workspace = memoryKv()
    const originalSetItem = workspace.setItem.bind(workspace)
    workspace.setItem = (key: string, value: unknown) => {
        if (key === 'aioman:profiles') throw new Error('quota exceeded')
        return originalSetItem(key, value)
    }

    assert.equal(await migrateLegacyIntoWorkspace(legacy, workspace, 'user-x'), 1)
    assert.deepEqual(await workspace.getItem('aioman:accounts'), [{ id: 'acc-1' }])
    // The copy was partial, so nothing is deleted yet: the next boot finishes the job.
    assert.deepEqual(await legacy.getItem('aioman:accounts'), [{ id: 'acc-1' }])
    assert.deepEqual(await legacy.getItem('aioman:profiles'), [{ id: 'p-1' }])
})

test('an empty legacy store just closes the window', async () => {
    const legacy = memoryKv()
    const workspace = memoryKv()

    assert.equal(await migrateLegacyIntoWorkspace(legacy, workspace, 'anyone'), 0)
    assert.equal(await legacy.getItem<string>(LEGACY_MIGRATED_FLAG), 'anyone')
})

test('initWorkspacePersistence routes an anonymous boot to its own database', async () => {
    await initWorkspacePersistence()
    assert.equal(getActiveWorkspaceId(), ANON_WORKSPACE_ID)

    await localforage.setItem('boot-check', true)
    assert.equal(await databaseFor(ANON_WORKSPACE_ID).getItem('boot-check'), true)
})
