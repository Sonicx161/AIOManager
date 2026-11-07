import { addonManifestUrl } from '../utils/addon-endpoint-url.js'
import { STREMIO_API } from '../config.js'
import { enqueueProxyRequest } from '../proxy-queue.js'
import { trace } from '../utils/trace.js'

export const STREMIO_DRIVER_TIMEOUT_MS = 20_000

const isTimeout = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError'

// A body without a collection is an error, never an empty account.
const collectionOf = (body) => {
    const result = body?.result
    if (body?.error || !result || typeof result !== 'object') {
        const detail = body?.error ? (typeof body.error === 'string' ? body.error : body.error.message || body.error.code || 'error') : 'missing result'
        throw new Error(`Stremio addonCollectionGet failed: ${detail}`)
    }
    if (!('addons' in result)) throw new Error('Stremio addonCollectionGet failed: addon collection field missing')
    if (result.addons !== null && !Array.isArray(result.addons)) throw new Error('Stremio addonCollectionGet failed: addon collection is not a list')
    return result.addons
}

export function createStremioDriver({ timeoutMs = STREMIO_DRIVER_TIMEOUT_MS } = {}) {
    return {
        capabilities: ['addons'],

        async readAddons(authKey) {
            const getCollection = async () => {
                try {
                    const res = await enqueueProxyRequest(STREMIO_API, () => fetch(`${STREMIO_API}/addonCollectionGet`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: 'AddonCollectionGet', authKey }),
                        signal: AbortSignal.timeout(timeoutMs)
                    }))
                    if (!res.ok) {
                        const body = await res.text().catch(() => '')
                        const err = new Error(`Stremio API ${res.status}: ${body}`)
                        err.status = res.status
                        err._authExpired = (res.status === 401 || res.status === 403)
                        throw err
                    }
                    return await res.json()
                } catch (err) {
                    if (isTimeout(err)) {
                        const timeoutErr = new Error('Stremio addonCollectionGet timed out')
                        timeoutErr.timedOut = true
                        throw timeoutErr
                    }
                    throw err
                }
            }
            let addons = collectionOf(await getCollection())
            if (addons === null) {
                // a null collection is corrupted server-side and stays null until a Set re-initializes it
                trace('stremio-driver', 'addons-null-repair', {})
                await this.writeAddons(authKey, [])
                addons = collectionOf(await getCollection())
                if (!Array.isArray(addons)) throw new Error('Stremio addonCollectionGet failed: collection still null after repair')
            }
            return addons
        },

        async writeAddons(authKey, addons) {
            try {
                const res = await enqueueProxyRequest(STREMIO_API, () => fetch(`${STREMIO_API}/addonCollectionSet`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'AddonCollectionSet', authKey, addons: addons.map(addon => ({ ...addon, transportUrl: addonManifestUrl(addon.transportUrl) })) }),
                    signal: AbortSignal.timeout(timeoutMs)
                }))
                if (!res.ok) {
                    const body = await res.text().catch(() => '')
                    const err = new Error(`addonCollectionSet returned ${res.status}: ${body}`)
                    err.status = res.status
                    err._authExpired = (res.status === 401 || res.status === 403)
                    throw err
                }
                return await res.json()
            } catch (err) {
                // The write may have landed: callers re-read next cycle instead of re-writing now.
                if (isTimeout(err)) {
                    const timeoutErr = new Error('addonCollectionSet timed out; outcome unknown')
                    timeoutErr.timedOut = true
                    timeoutErr.outcomeUnknown = true
                    throw timeoutErr
                }
                throw err
            }
        }
    }
}
