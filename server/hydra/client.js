import { isSafeUrlResolved } from '../utils/ssrf.js'
import { guardedResilientFetch } from '../utils/safe-fetch.js'
import { normalizeHydraAddonInput } from '../utils/addon-shape.js'

const DEFAULT_TIMEOUT = 15000
const HEALTH_TIMEOUT = 8000

// A remote Hydra instance cannot resolve another device's loopback/private addon URLs;
// pushing them makes the whole collection write fail with 400.
export const isLocalHostname = (url) => {
    try {
        const h = new URL(url).hostname
        return h === 'localhost' || h === '127.0.0.1' || h === '::1' || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    } catch { return true }
}

const UNSAFE_BASE_MESSAGE = 'Unsafe or private Hydra baseUrl'

const resilientFetch = async (url, options) => {
    try {
        return await guardedResilientFetch(url, options)
    } catch (err) {
        if (err.code === 'ssrf-blocked') throw new Error(UNSAFE_BASE_MESSAGE)
        throw err
    }
}

export async function createHydraClient(config) {
    const base = (config.baseUrl || '').replace(/\/+$/, '')
    if (!base || !(await isSafeUrlResolved(base))) {
        throw new Error(UNSAFE_BASE_MESSAGE)
    }

    const makeHeaders = () => {
        if (config.authType === 'api-key') {
            return { [config.authHeader || 'X-API-Key']: config.authValue || '' }
        }
        if (config.authType === 'bearer') {
            return { 'Authorization': `Bearer ${config.authValue || ''}` }
        }
        if (config.authType === 'basic') {
            return { 'Authorization': `Basic ${Buffer.from(config.authValue || '').toString('base64')}` }
        }
        return {}
    }

    return {
        capabilities: ['addons'],

        async status() {
            const r = await resilientFetch(`${base}/hydra/status`, {
                headers: makeHeaders(),
                timeout: DEFAULT_TIMEOUT,
            })
            if (!r.ok) throw new Error(`Hydra status failed: ${r.status}`)
            return r.json()
        },

        async readAddons() {
            const r = await resilientFetch(`${base}/hydra/addons`, {
                headers: makeHeaders(),
                timeout: DEFAULT_TIMEOUT,
            })
            if (!r.ok) throw new Error(`Hydra readAddons failed: ${r.status}`)
            const body = await r.json()
            return body.addons ?? body
        },

        async writeAddons(addons) {
            const flat = (addons || []).map(a => {
                const n = normalizeHydraAddonInput(a)
                if (!n) return null
                if (isLocalHostname(n.transportUrl)) return null
                return {
                    transportUrl: n.transportUrl,
                    id: n.manifest.id,
                    name: n.manifest.name,
                    version: n.manifest.version,
                    logo: n.manifest.logo,
                    enabled: n.flags.enabled,
                    types: n.manifest.types,
                    resources: n.manifest.resources,
                }
            }).filter(Boolean)
            const r = await resilientFetch(`${base}/hydra/addons`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...makeHeaders() },
                body: JSON.stringify({ addons: flat }),
                timeout: DEFAULT_TIMEOUT,
            })
            if (!r.ok) throw new Error(`Hydra writeAddons failed: ${r.status}`)
            return r.json()
        },

        async healthCheck(addonUrl) {
            const encoded = encodeURIComponent(addonUrl)
            const r = await resilientFetch(`${base}/hydra/addons/${encoded}/health`, {
                headers: makeHeaders(),
                timeout: HEALTH_TIMEOUT,
            })
            return r.ok
        },
    }
}
