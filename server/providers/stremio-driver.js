import { addonManifestUrl } from '../utils/addon-endpoint-url.js'
import { STREMIO_API } from '../config.js'
import { enqueueProxyRequest } from '../proxy-queue.js'
import { trace } from '../utils/trace.js'

export function createStremioDriver() {
    return {
        capabilities: ['addons'],

        async readAddons(authKey) {
            const getCollection = async () => {
                const res = await enqueueProxyRequest(STREMIO_API, () => fetch(`${STREMIO_API}/addonCollectionGet`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'AddonCollectionGet', authKey })
                }))
                if (!res.ok) {
                    const body = await res.text().catch(() => '')
                    const err = new Error(`Stremio API ${res.status}: ${body}`)
                    err.status = res.status
                    err._authExpired = (res.status === 401 || res.status === 403)
                    throw err
                }
                return res.json()
            }
            const first = await getCollection()
            let addons = first?.result?.addons
            if (addons == null && first?.result) {
                // a null collection is corrupted server-side and stays null until a Set re-initializes it
                trace('stremio-driver', 'addons-null-repair', {})
                await this.writeAddons(authKey, [])
                addons = (await getCollection())?.result?.addons
            }
            return addons || []
        },

        async writeAddons(authKey, addons) {
            const res = await enqueueProxyRequest(STREMIO_API, () => fetch(`${STREMIO_API}/addonCollectionSet`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'AddonCollectionSet', authKey, addons: addons.map(addon => ({ ...addon, transportUrl: addonManifestUrl(addon.transportUrl) })) })
            }))
            if (!res.ok) {
                const body = await res.text().catch(() => '')
                const err = new Error(`addonCollectionSet returned ${res.status}: ${body}`)
                err.status = res.status
                err._authExpired = (res.status === 401 || res.status === 403)
                throw err
            }
            return res.json()
        }
    }
}
