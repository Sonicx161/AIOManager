import { addonManifestUrl } from '@/lib/addon-endpoint-url'
import { AddonDescriptor, AddonManifest } from '@/types/addon'
import { LibraryItem } from '@/types/activity'
import { resilientFetch } from '@/lib/api-resilience'
import { useSyncStore } from '@/store/syncStore'
import { deriveSyncToken } from '@/lib/crypto'
import { getHostnameIdentifier, identifyAddon } from '@/lib/addon-identifier'
import { trace } from '@/lib/trace'
import { ACCOUNT_CONTEXT_SYSTEM_CHECK } from '@/lib/account-contexts'
import { exchangeFacebookLogin, exchangeAppleLogin, deleteStremioUser, type RelayLoginResult } from './stremio-relay'

async function getProxyAuthHeaders(): Promise<Record<string, string>> {
    const { auth } = useSyncStore.getState()
    if (!auth.isAuthenticated) return {}
    return {
        'x-sync-user': auth.id,
        'x-sync-password': await deriveSyncToken(auth.password),
    }
}

const API_BASE = 'https://api.strem.io'

export interface LoginResponse {
  authKey: string
  user: {
    _id: string
    email: string
    avatar?: string
  }
}

export interface AddonCollectionResponse {
  addons: AddonDescriptor[]
  lastModified: number
}

interface SetAddonCollectionOptions {
  allowCollectionShrink?: boolean
  previousCollection?: AddonDescriptor[]
}

const ADDON_REFRESH_ERROR_PATTERN = /AddonsPulledFromAPI|UserAddonsLocked|manifest.*missing field|upstream returned 403|forbidden|access denied|status\s*403|\b403\b/i

async function serverPost(path: string, body: Record<string, unknown>, headers?: Record<string, string>) {
  const authHeaders = await getProxyAuthHeaders()
  const res = await resilientFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...headers },
    body: JSON.stringify(body),
    timeout: 30000,
  })
  const text = await res.text()
  let data: Record<string, unknown>
  try { data = JSON.parse(text) } catch { data = {} }
  if (!res.ok) {
    const errorVal = data?.error
    throw new Error((typeof errorVal === 'string' ? errorVal : (errorVal as Record<string, unknown>)?.message as string) || `Server error: ${res.status}`)
  }
  return data
}

export class StremioClient {

  async login(email: string, password: string): Promise<LoginResponse> {
    try {
      const response = await resilientFetch(`${API_BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'Auth', email, password })
      })

      let data: Record<string, unknown>
      try { data = await response.json() } catch { throw new Error('Invalid response from Stremio API') }

      if (data?.error) {
        const errData = data.error as Record<string, unknown>
        const message = typeof errData.message === 'string' ? errData.message : (typeof errData === 'string' ? String(errData) : 'Login failed')
        const err = new Error(typeof message === 'string' ? message : JSON.stringify(message))
        const code = errData.code || errData.message
          ; (err as unknown as Record<string, unknown>).code = typeof code === 'string' ? code : JSON.stringify(code)
        throw err
      }

      if (!(data?.result as Record<string, unknown>)?.authKey) {
        throw new Error('Invalid login response - no auth key')
      }

      return (data as { result: LoginResponse }).result
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('401')) throw new Error('Invalid email or password')
        if (error.message.includes('Failed to fetch')) throw new Error('Network error - check your internet connection')
      }
      throw error
    }
  }

  async register(email: string, password: string): Promise<LoginResponse> {
    try {
      const response = await resilientFetch(`${API_BASE}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'Auth', email, password })
      })

      let data: Record<string, unknown>
      try { data = await response.json() } catch { throw new Error('Invalid response from Stremio API') }

      if (data?.error) {
        const errData = data.error as Record<string, unknown>
        throw new Error((typeof errData.message === 'string' ? errData.message : undefined) || 'Registration failed')
      }

      if (!(data?.result as Record<string, unknown>)?.authKey) {
        throw new Error('Invalid registration response - no auth key')
      }

      return (data as { result: LoginResponse }).result
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('401')) throw new Error('Invalid email or password')
        if (error.message.includes('Failed to fetch')) throw new Error('Network error - check your internet connection')
      }
      throw error
    }
  }

  async authWithFacebook(fbLoginToken: string): Promise<LoginResponse> {
    try {
      const result = await exchangeFacebookLogin(fbLoginToken)
      return this.mapRelayLogin(result)
    } catch (error) {
      if (error instanceof Error && error.message.includes('Failed to fetch')) throw new Error('Network error - check your internet connection')
      throw error
    }
  }

  async authWithApple(credentials: { token: string; sub: string; email: string; name: string }): Promise<LoginResponse> {
    try {
      const result = await exchangeAppleLogin(credentials)
      return this.mapRelayLogin(result)
    } catch (error) {
      if (error instanceof Error && error.message.includes('Failed to fetch')) throw new Error('Network error - check your internet connection')
      throw error
    }
  }

  async deleteUser(authKey: string, password: string): Promise<void> {
    await deleteStremioUser(authKey, password)
  }

  private mapRelayLogin(result: RelayLoginResult): LoginResponse {
    return { authKey: result.authKey, user: { _id: result.user._id || '', email: result.user.email || '' } }
  }

  async getUser(authKey: string): Promise<{
    email: string
    _id: string
    premiumPrefs?: {
      userProfiles?: Record<string, { id: string; name: string; avatar?: string }>
    }
  }> {
    try {
      const data = await serverPost('/api/stremio-proxy', {
        type: 'GetUser',
        authKey,
      }, { 'x-account-context': ACCOUNT_CONTEXT_SYSTEM_CHECK })

      if (data?.error) {
        const e = data.error as Record<string, unknown>
        throw new Error((e.message as string) || 'Failed to get user profile')
      }

      if (!data?.result) {
        throw new Error('Invalid getUser response')
      }

      return data.result as unknown as {
        email: string
        _id: string
        premiumPrefs?: {
          userProfiles?: Record<string, { id: string; name: string; avatar?: string }>
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        throw new Error('Invalid or expired auth key')
      }
      throw error
    }
  }

  async getProfilesAddons(authKey: string, accountContext: string = ACCOUNT_CONTEXT_SYSTEM_CHECK): Promise<Record<string, AddonDescriptor[]>> {
    try {
      const data = await serverPost('/api/stremio-proxy', {
        type: 'GetProfilesAddons',
        authKey,
      }, { 'x-account-context': accountContext })

      if (data?.error) {
        const e = data.error as Record<string, unknown>
        throw new Error((e.message as string) || 'Failed to get sub-profile addons')
      }

      const profiles = (data?.result as Record<string, unknown>)?.profiles as Record<string, { addons?: unknown[] }> | undefined
      if (!profiles) return {}

      const result: Record<string, AddonDescriptor[]> = {}
      for (const [profileId, profile] of Object.entries(profiles)) {
        const addons = Array.isArray(profile?.addons) ? profile.addons : []
        result[profileId] = (addons as Record<string, unknown>[]).map((addon) => ({
            ...addon,
            manifest: {
                ...(addon.manifest as Record<string, unknown> || {}),
                types: (addon.manifest as Record<string, unknown>)?.types || [],
                resources: (addon.manifest as Record<string, unknown>)?.resources || []
            }
        })) as AddonDescriptor[]
      }
      return result
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        throw new Error('Invalid or expired auth key')
      }
      throw error
    }
  }

  async getAddonCollection(authKey: string, accountContext: string = ACCOUNT_CONTEXT_SYSTEM_CHECK, update: boolean = true): Promise<AddonDescriptor[]> {
    try {
      const start = Date.now()
      const fetchCollection = (shouldUpdate: boolean) => serverPost('/api/stremio-proxy', {
          type: 'AddonCollectionGet',
          authKey,
          update: shouldUpdate,
        }, { 'x-account-context': accountContext })

      let data = await fetchCollection(update)
      trace('stremio', 'api-call', { method: 'AddonCollectionGet', timing: Date.now() - start })

      if (data?.error) {
        const errorText = typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
        if (update && ADDON_REFRESH_ERROR_PATTERN.test(errorText)) {
          if (import.meta.env.DEV) console.warn('[Stremio] Live addon refresh failed; falling back to stored collection:', errorText)
          data = await fetchCollection(false)
        }
      }

      if (data?.error) {
        const e = data.error as Record<string, unknown>
        const message = typeof data.error === 'string' ? data.error : (e.message as string)
        throw new Error(message || 'Failed to get addon collection')
      }

      const result = data?.result as Record<string, unknown> | undefined
      if (result && typeof result === 'object' && !('addons' in result)) {
        throw new Error('Stremio returned unexpected response - addon collection field missing')
      }
      if (!result?.addons) {
        return []
      }

       return (result.addons as Record<string, unknown>[]).map((addon: Record<string, unknown>) => {
         const transportUrl = (addon.transportUrl as string) || ''
         const manifest = (addon.manifest || {}) as Record<string, unknown>
         const rawManifest = (!manifest.name && addon.transportName)
           ? { ...manifest, name: addon.transportName as string }
           : manifest
         const identifiedManifest = identifyAddon(transportUrl, rawManifest)
         return {
           ...(addon as unknown as AddonDescriptor),
           manifest: {
             ...identifiedManifest,
             id: identifiedManifest.id || 'unknown',
             name: identifiedManifest.name || getHostnameIdentifier(transportUrl),
             version: identifiedManifest.version || '0.0.0',
             description: identifiedManifest.description || '',
             types: identifiedManifest.types || [],
             resources: identifiedManifest.resources || []
           }
         }
       })
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('401')) throw new Error('Invalid or expired auth key')
        if (error.message.includes('Failed to fetch')) throw new Error('Network error - check your internet connection or CORS configuration')
      }
      throw error
    }
  }

  async setAddonCollection(authKey: string, addons: AddonDescriptor[], accountContext: string = ACCOUNT_CONTEXT_SYSTEM_CHECK, options: SetAddonCollectionOptions = {}): Promise<void> {
    try {
      const shouldVerifyShrink = !options.allowCollectionShrink
      const previousCollection = shouldVerifyShrink
        ? options.previousCollection ?? await this.getAddonCollection(authKey, accountContext).catch(() => null)
        : null
      const previousCount = previousCollection?.length || 0
      const start = Date.now()
      const data = await serverPost('/api/stremio-proxy', {
        type: 'AddonCollectionSet',
        authKey,
        addons: addons.map(addon => ({ ...addon, transportUrl: addonManifestUrl(addon.transportUrl) })),
        allowCollectionShrink: Boolean(options.allowCollectionShrink),
      }, { 'x-account-context': accountContext })
      trace('stremio', 'api-call', { method: 'AddonCollectionSet', timing: Date.now() - start })

      if (data?.error) {
        const err = data.error as Record<string, unknown>
        const rawMessage = (err.message as string) || 'Failed to update addon collection'
        if (/descriptor.*size|payload.*too.*large|max.*size|413/i.test(rawMessage)) {
          throw new Error('Stremio rejected this addon - too many catalogs. This addon has too many catalogs for Stremio\'s size limit. Reduce the number of catalogs on this addon\'s configuration page, then try again.')
        }
        throw new Error(rawMessage)
      }

      const verificationCollection = shouldVerifyShrink
        ? await this.getAddonCollection(authKey, accountContext, false).catch(() => null)
        : null
      if (
        shouldVerifyShrink &&
        previousCount > 0 &&
        verificationCollection &&
        verificationCollection.length < Math.ceil(previousCount * 0.25)
      ) {
        await serverPost('/api/stremio-proxy', {
          type: 'AddonCollectionSet',
          authKey,
          addons: previousCollection?.map(addon => ({ ...addon, transportUrl: addonManifestUrl(addon.transportUrl) })),
        }, { 'x-account-context': `${accountContext}: rollback` }).catch((rollbackError) => {
          if (import.meta.env.DEV) console.error('[Stremio] Failed to rollback suspicious addon collection shrink:', rollbackError)
        })
        throw new Error(`Safety rollback: Stremio accepted a suspicious addon collection shrink (${previousCount} → ${verificationCollection.length}). Previous collection was restored.`)
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('401')) throw new Error('Invalid or expired auth key')
        if (error.message.includes('Failed to fetch')) throw new Error('Network error - check your internet connection or CORS configuration')
      }
      throw error
    }
  }

  private readonly DIRECT_FETCH_DOMAINS = ['v3-cinemeta.strem.io', 'cinemeta.strem.io', 'opensubtitles-v3.strem.io', 'www.strem.io', 'v3-channels.strem.io', '127.0.0.1', 'localhost']

  async fetchAddonManifest(transportUrl: string, accountContext: string = ACCOUNT_CONTEXT_SYSTEM_CHECK, force: boolean = false, retries = 2): Promise<AddonDescriptor> {
    const manifestUrl = addonManifestUrl(transportUrl)

    const shouldFetchDirectly = this.DIRECT_FETCH_DOMAINS.some((domain) => {
      try {
        return new URL(manifestUrl).hostname === domain
      } catch {
        return false
      }
    })

    const interval = force ? Date.now() : Math.floor(Date.now() / 1800000)

    const fetchUrl = shouldFetchDirectly
      ? manifestUrl
      : `/api/meta-proxy?url=${encodeURIComponent(manifestUrl)}&cb=${interval}${force ? '&nocache=1' : ''}`

    try {
      if (import.meta.env.DEV) console.log(
        `[Manifest Fetch] Fetching ${shouldFetchDirectly ? 'directly' : 'via proxy'}: ${manifestUrl}`
      )

      const proxyAuthHeaders = shouldFetchDirectly ? {} : await getProxyAuthHeaders()
      const response = await resilientFetch(fetchUrl, {
        timeout: 15000,
        headers: shouldFetchDirectly ? {} : { ...proxyAuthHeaders, 'x-account-context': accountContext },
        retries: retries
      })

      if (!response.ok) {
        if (response.status === 404) throw new Error('Addon manifest not found at this URL')
        throw new Error(`Addon server responded with ${response.status}`)
      }

      let manifestData: Record<string, unknown>
      try {
        manifestData = await response.json()
      } catch {
        throw new Error('Invalid response from Stremio API')
      }

      if (!manifestData?.id || !manifestData?.name || !manifestData?.version) {
        if (import.meta.env.DEV) console.error(`[Manifest Fetch] Missing fields for ${manifestUrl}:`, manifestData)
        throw new Error('Invalid addon manifest - missing required fields')
      }

      const sanitizedManifest = {
        ...manifestData,
        types: (manifestData.types as string[]) || [],
        resources: (manifestData.resources as AddonManifest['resources']) || []
      }
      const identifiedManifest = identifyAddon(transportUrl, sanitizedManifest)

      return {
        transportUrl: manifestUrl,
        manifest: {
          ...identifiedManifest,
          id: identifiedManifest.id || 'unknown',
          name: identifiedManifest.name || getHostnameIdentifier(transportUrl),
          version: identifiedManifest.version || '0.0.0',
          description: identifiedManifest.description || '',
          types: identifiedManifest.types || [],
          resources: identifiedManifest.resources || []
        },
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn(
          `[Manifest Fetch] Failed for ${manifestUrl}:`,
          error instanceof Error ? error.message : error
        )
      }
      throw error
    }
  }

  async getLibraryItems(authKey: string, accountContext: string = ACCOUNT_CONTEXT_SYSTEM_CHECK): Promise<LibraryItem[]> {
    try {
      const start = Date.now()
      const data = await serverPost('/api/stremio-proxy', {
        type: 'DatastoreGet',
        authKey,
        collection: 'libraryItem',
        all: true
      }, { 'x-account-context': accountContext })
      trace('stremio', 'api-call', { method: 'DatastoreGet', timing: Date.now() - start })

      if (data?.error) {
        const e = data.error as Record<string, unknown>
        throw new Error((e.message as string) || 'Failed to get library items')
      }

      const result = data?.result as unknown
      if (Array.isArray(result)) {
        return result as LibraryItem[]
      }
      if (result && typeof result === 'object' && Array.isArray((result as Record<string, unknown>).library)) {
        return (result as Record<string, LibraryItem[]>).library
      }

      return []
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('401')) throw new Error('Invalid or expired auth key')
        if (error.message.includes('Failed to fetch')) throw new Error('Network error - check your internet connection or CORS configuration')
      }
      throw error
    }
  }

  async getLibraryItemsByIds(authKey: string, ids: string[], accountContext: string = ACCOUNT_CONTEXT_SYSTEM_CHECK): Promise<LibraryItem[]> {
    try {
      const start = Date.now()
      const data = await serverPost('/api/stremio-proxy', {
        type: 'DatastoreGet',
        authKey,
        collection: 'libraryItem',
        ids
      }, { 'x-account-context': accountContext })
      trace('stremio', 'api-call', { method: 'DatastoreGet', timing: Date.now() - start, ids: ids.length })

      if (data?.error) {
        const e = data.error as Record<string, unknown>
        throw new Error((e.message as string) || 'Failed to get library items')
      }
      if (data?.result === false) {
        throw new Error('Stremio rejected the library items request')
      }

      const result = data?.result as unknown
      if (Array.isArray(result)) {
        return result as LibraryItem[]
      }
      if (result && typeof result === 'object' && Array.isArray((result as Record<string, unknown>).library)) {
        return (result as Record<string, LibraryItem[]>).library
      }

      return []
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('401')) throw new Error('Invalid or expired auth key')
        if (error.message.includes('Failed to fetch')) throw new Error('Network error - check your internet connection or CORS configuration')
      }
      throw error
    }
  }

  // Wire invariant: the proxy derives the upstream path from the type
  // ('DatastoreMeta' -> /api/datastoreMeta) and the result is [[itemId, mtimeMs], ...].
  async getLibraryMeta(authKey: string, accountContext: string = ACCOUNT_CONTEXT_SYSTEM_CHECK): Promise<Array<[string, number]>> {
    try {
      const start = Date.now()
      const data = await serverPost('/api/stremio-proxy', {
        type: 'DatastoreMeta',
        authKey,
        collection: 'libraryItem'
      }, { 'x-account-context': accountContext })
      trace('stremio', 'api-call', { method: 'DatastoreMeta', timing: Date.now() - start })

      if (data?.error) {
        const e = data.error as Record<string, unknown>
        throw new Error((e.message as string) || 'Failed to get library meta')
      }
      if (data?.result === false) {
        throw new Error('Stremio rejected the library meta request')
      }

      const result = data?.result as unknown
      if (Array.isArray(result)) {
        return result as Array<[string, number]>
      }
      return []
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('401')) throw new Error('Invalid or expired auth key')
        if (error.message.includes('Failed to fetch')) throw new Error('Network error - check your internet connection or CORS configuration')
      }
      throw error
    }
  }

  async testCORS(): Promise<boolean> {
    try {
      await fetch(`${API_BASE}/api/addonCollectionGet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'AddonCollectionGet', authKey: 'test' })
      })
      return true
    } catch {
      return false
    }
  }

  async addLibraryItem(authKey: string, item: {
    id: string
    name: string
    type: string
    poster?: string
  }, accountContext: string = ACCOUNT_CONTEXT_SYSTEM_CHECK): Promise<void> {
    try {
      const libraryItem = {
        _id: item.id,
        name: item.name,
        type: item.type,
        poster: item.poster || '',
        removed: false,
        temp: false,
        _ctime: new Date().toISOString(),
        _mtime: new Date().toISOString(),
        state: {}
      }

      const data = await serverPost('/api/stremio-proxy', {
        type: 'DatastorePut',
        authKey,
        collection: 'libraryItem',
        changes: [libraryItem]
      }, { 'x-account-context': accountContext })

      if (data?.error) {
        const err = data.error as Record<string, unknown>
        throw new Error((err.message as string) || 'Failed to add library item')
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        throw new Error('Invalid or expired auth key')
      }
      throw error
    }
  }

  async pushLibraryItems(authKey: string, items: LibraryItem[], accountContext: string = ACCOUNT_CONTEXT_SYSTEM_CHECK): Promise<void> {
    try {
      const BATCH_SIZE = 100
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE)
        const changes = batch.map(item => ({
          ...item,
          _mtime: item._mtime || new Date().toISOString(),
        }))

        const data = await serverPost('/api/stremio-proxy', {
          type: 'DatastorePut',
          authKey,
          collection: 'libraryItem',
          changes
        }, { 'x-account-context': accountContext })

        if (data?.error) {
          const err = data.error as Record<string, unknown>
          throw new Error((err.message as string) || (typeof data.error === 'string' ? String(data.error) : '') || 'Failed to push library items')
        }
        if (data?.result === false) {
          throw new Error('Stremio rejected the library update')
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        throw new Error('Invalid or expired auth key')
      }
      throw error
    }
  }

  async upsertLibraryItem(authKey: string, item: LibraryItem, accountContext: string = ACCOUNT_CONTEXT_SYSTEM_CHECK): Promise<void> {
    try {
      // Preserve a caller-supplied mtime: bitfield rewrites must not masquerade as fresh watches.
      const fullItem = { ...item, removed: false, _mtime: item._mtime || new Date().toISOString() }

      const data = await serverPost('/api/stremio-proxy', {
        type: 'DatastorePut',
        authKey,
        collection: 'libraryItem',
        changes: [fullItem]
      }, { 'x-account-context': accountContext })

      if (data?.error) {
        const err = data.error as Record<string, unknown>
        throw new Error((err.message as string) || 'Failed to update library item')
      }
      if (data?.result === false) {
        throw new Error('Stremio rejected the library update')
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        throw new Error('Invalid or expired auth key')
      }
      throw error
    }
  }

  async removeLibraryItem(authKey: string, item: LibraryItem | string, accountContext: string = ACCOUNT_CONTEXT_SYSTEM_CHECK): Promise<void> {
    try {
      const fullItem = typeof item === 'string'
        ? { _id: item, removed: true, _mtime: new Date().toISOString() }
        : { ...item, removed: true, _mtime: new Date().toISOString() }

      const data = await serverPost('/api/stremio-proxy', {
        type: 'DatastorePut',
        authKey,
        collection: 'libraryItem',
        changes: [fullItem]
      }, { 'x-account-context': accountContext })

      if (data?.error) {
        const err = data.error as Record<string, unknown>
        throw new Error((err.message as string) || 'Failed to remove library item')
      }
      if (data?.result === false) {
        throw new Error('Stremio rejected the library removal')
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        throw new Error('Invalid or expired auth key')
      }
      throw error
    }
  }
}

export const stremioClient = new StremioClient()
