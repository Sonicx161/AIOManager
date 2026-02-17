import { AddonDescriptor } from '@/types/addon'
import { LibraryItem } from '@/types/activity'
import axios, { AxiosInstance } from 'axios'
import { resilientFetch } from '@/lib/api-resilience'

// API endpoint - we'll test CORS first, may need to use a proxy
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


export class StremioClient {
  private client: AxiosInstance
  private serverClient: AxiosInstance

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    })

    this.serverClient = axios.create({
      baseURL: '/api',
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    })
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    try {
      const response = await resilientFetch(`${API_BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'Auth', email, password })
      })

      const data = await response.json()

      if (data?.error) {
        const errData = data.error
        const message = typeof errData === 'string' ? errData : (errData.message || 'Login failed')
        const err = new Error(typeof message === 'string' ? message : JSON.stringify(message))
        const code = errData.code || errData.message
          ; (err as any).code = typeof code === 'string' ? code : JSON.stringify(code)
        throw err
      }

      if (!data?.result?.authKey) {
        throw new Error('Invalid login response - no auth key')
      }

      return data.result
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('401')) throw new Error('Invalid email or password')
        if (error.message.includes('Failed to fetch')) throw new Error('Network error - check your internet connection')
      }
      throw error
    }
  }

  async register(email: string, password: string): Promise<LoginResponse> {
    const response = await resilientFetch(`${API_BASE}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Auth', email, password })
    })

    const data = await response.json()

    if (data?.error) {
      throw new Error(data.error.message || 'Registration failed')
    }

    if (!data?.result?.authKey) {
      throw new Error('Invalid registration response - no auth key')
    }

    return data.result
  }

  async getUser(authKey: string): Promise<{ email: string, _id: string }> {
    try {
      const response = await this.serverClient.post('/stremio-proxy', {
        type: 'GetUser',
        authKey,
      }, {
        headers: {
          'x-account-context': 'System Check'
        }
      })

      if (response.data?.error) {
        throw new Error(response.data.error.message || 'Failed to get user profile')
      }

      if (!response.data?.result) {
        throw new Error('Invalid getUser response')
      }

      return response.data.result
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(error.response?.data?.error || error.message || 'Failed to get user profile')
      }
      throw error
    }
  }

  /**
   * Get user's addon collection
   */
  async getAddonCollection(authKey: string, accountContext: string = 'Unknown'): Promise<AddonDescriptor[]> {
    try {
      // Use the server proxy for collection management to enable backend logging
      const response = await this.serverClient.post('/stremio-proxy', {
        type: 'AddonCollectionGet',
        authKey,
        update: true,
      }, {
        headers: {
          'x-account-context': accountContext
        }
      })

      if (response.data?.error) {
        throw new Error(response.data.error.message || 'Failed to get addon collection')
      }

      const result = response.data?.result
      if (!result?.addons) {
        return []
      }

      return result.addons.map((addon: any) => ({
        ...addon,
        manifest: {
          ...addon.manifest,
          types: addon.manifest?.types || [],
          resources: addon.manifest?.resources || []
        }
      }))
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Invalid or expired auth key')
        }
        if (error.code === 'ERR_NETWORK') {
          throw new Error('Network error - check your internet connection or CORS configuration')
        }
        throw new Error(
          error.response?.data?.error || error.message || 'Failed to get addon collection'
        )
      }
      throw error
    }
  }

  /**
   * Update user's addon collection
   */
  async setAddonCollection(authKey: string, addons: AddonDescriptor[], accountContext: string = 'Unknown'): Promise<void> {
    try {
      // Use the server proxy for collection management to enable backend logging
      const response = await this.serverClient.post('/stremio-proxy', {
        type: 'AddonCollectionSet',
        authKey,
        addons,
      }, {
        headers: {
          'x-account-context': accountContext
        }
      })

      if (response.data?.error) {
        throw new Error(response.data.error.message || 'Failed to update addon collection')
      }
      // We wait a short moment for Stremio's consistency and then verify.
      setTimeout(async () => {
        try {
          const verified = await this.getAddonCollection(authKey, accountContext)
          if (verified.length < addons.length) {
            console.warn(`[Sync] Stremio collection mismatch after update: ${addons.length} sent, ${verified.length} reported.`)
          }
        } catch (e) {
          console.warn('[Sync] Post-sync verification failed:', e)
        }
      }, 2000)
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Invalid or expired auth key')
        }
        if (error.code === 'ERR_NETWORK') {
          throw new Error('Network error - check your internet connection or CORS configuration')
        }
        throw new Error(
          error.response?.data?.error || error.message || 'Failed to update addon collection'
        )
      }
      throw error
    }
  }

  /**
   * Domains that should be fetched directly without using the proxy
   * Add domains here that have proper CORS headers or are official Stremio services
   */
  private readonly DIRECT_FETCH_DOMAINS = ['v3-cinemeta.strem.io', 'cinemeta.strem.io', 'strem.io']

  /**
   * Fetch addon manifest from URL
   * Uses CORS proxy to avoid cross-origin issues with addon servers
   * Some domains (like official Stremio services) are fetched directly
   */
  async fetchAddonManifest(transportUrl: string, accountContext: string = 'Unknown', retries = 2): Promise<AddonDescriptor> {
    // Determine the manifest URL
    let manifestUrl: string
    if (transportUrl.endsWith('/manifest.json') || transportUrl.includes('/manifest.json?')) {
      manifestUrl = transportUrl
    } else {
      // Try to append /manifest.json
      manifestUrl = transportUrl.endsWith('/')
        ? `${transportUrl}manifest.json`
        : `${transportUrl}/manifest.json`
    }

    // Check if this URL should be fetched directly (skip proxy for allowed domains)
    const shouldFetchDirectly = this.DIRECT_FETCH_DOMAINS.some((domain) =>
      manifestUrl.includes(domain)
    )

    // Add a 30-minute cache buster (1800000ms = 30 minutes)
    // Increased from 5 minutes to reduce proxy usage and improve performance
    const interval = Math.floor(Date.now() / 1800000)
    const cacheBuster = `cb=${interval}`
    const separator = manifestUrl.includes('?') ? '&' : '?'
    const finalManifestUrl = `${manifestUrl}${separator}${cacheBuster}`

    // Use internal proxy only for URLs that need it (most addon servers don't have CORS headers)
    const fetchUrl = shouldFetchDirectly
      ? finalManifestUrl
      : `/api/meta-proxy?url=${encodeURIComponent(finalManifestUrl)}`

    try {
      console.log(
        `[Manifest Fetch] Fetching ${shouldFetchDirectly ? 'directly' : 'via proxy'}: ${manifestUrl}`
      )

      const response = await resilientFetch(fetchUrl, {
        timeout: 15000,
        headers: shouldFetchDirectly ? {} : { 'x-account-context': accountContext },
        retries: retries
      })

      if (!response.ok) {
        if (response.status === 404) throw new Error('Addon manifest not found at this URL')
        throw new Error(`Addon server responded with ${response.status}`)
      }

      // allorigins might return the data as a string, so parse it if needed
      const manifestData = await response.json()

      if (!manifestData?.id || !manifestData?.name || !manifestData?.version) {
        console.error(`[Manifest Fetch] Missing fields for ${manifestUrl}:`, manifestData)
        throw new Error('Invalid addon manifest - missing required fields')
      }

      // Sanitize manifest to ensure Stremio compliance (Fixes "missing field types")
      const sanitizedManifest = {
        ...manifestData,
        types: manifestData.types || [],
        resources: manifestData.resources || []
      }

      return {
        transportUrl,
        manifest: sanitizedManifest,
      }
    } catch (error) {
      console.warn(
        `[Manifest Fetch] Failed for ${manifestUrl}:`,
        error instanceof Error ? error.message : error
      )
      throw error
    }
  }



  /**
   * Get user's library items (Watch History)
   * Uses datastoreGet with collection: 'libraryItem' to match Syncio's implementation
   */
  async getLibraryItems(authKey: string, accountContext: string = 'Unknown'): Promise<LibraryItem[]> {
    try {
      const response = await this.serverClient.post('/stremio-proxy', {
        type: 'DatastoreGet',
        authKey,
        collection: 'libraryItem',
        all: true
      }, {
        headers: {
          'x-account-context': accountContext
        }
      })

      if (response.data?.error) {
        throw new Error(response.data.error.message || 'Failed to get library items')
      }

      // datastoreGet returns the array directly in result, or as result.library
      const result = response.data?.result
      if (Array.isArray(result)) {
        return result
      }
      if (result?.library && Array.isArray(result.library)) {
        return result.library
      }

      return []
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Invalid or expired auth key')
        }
        if (error.code === 'ERR_NETWORK') {
          throw new Error('Network error - check your internet connection or CORS configuration')
        }
        throw new Error(
          error.response?.data?.error || error.message || 'Failed to get library items'
        )
      }
      throw error
    }
  }

  /**
   * Test CORS access to the API
   */
  async testCORS(): Promise<boolean> {
    try {
      await this.client.post('/api/addonCollectionGet', {
        type: 'AddonCollectionGet',
        authKey: 'test',
      })
      return true
    } catch (error) {
      if (axios.isAxiosError(error)) {
        // If we get a response (even error response), CORS is working
        if (error.response) {
          return true
        }
        // Network error likely means CORS issue
        if (error.code === 'ERR_NETWORK') {
          return false
        }
      }
      return false
    }
  }

  /**
   * Add an item to a user's library
   */
  async addLibraryItem(authKey: string, item: {
    id: string
    name: string
    type: string
    poster?: string
  }, accountContext: string = 'Unknown'): Promise<void> {
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

      await this.serverClient.post('/stremio-proxy', {
        type: 'DatastorePut',
        authKey,
        collection: 'libraryItem',
        changes: [libraryItem]
      }, {
        headers: {
          'x-account-context': accountContext
        }
      })
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Invalid or expired auth key')
        }
        throw new Error(error.response?.data?.error || error.message || 'Failed to add library item')
      }
      throw error
    }
  }

  /**
   * Remove an item from a user's library (marks as removed)
   */
  async removeLibraryItem(authKey: string, itemId: string, accountContext: string = 'Unknown'): Promise<void> {
    try {
      const libraryItem = {
        _id: itemId,
        removed: true,
        _mtime: new Date().toISOString(),
        state: {
          timeWatched: 0,
          timesWatched: 0,
          flaggedWatched: 0,
          overallTimeWatched: 0,
          timeOffset: 0,
          lastWatched: '',
          video_id: '',
          watched: '',
          noNotif: false,
          season: 0,
          episode: 0,
          duration: 0
        }
      }

      await this.serverClient.post('/stremio-proxy', {
        type: 'DatastorePut',
        authKey,
        collection: 'libraryItem',
        changes: [libraryItem]
      }, {
        headers: {
          'x-account-context': accountContext
        }
      })
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Invalid or expired auth key')
        }
        throw new Error(error.response?.data?.error || error.message || 'Failed to remove library item')
      }
      throw error
    }
  }
}

export const stremioClient = new StremioClient()
