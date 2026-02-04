import { AddonDescriptor } from '@/types/addon'
import axios, { AxiosInstance } from 'axios'

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

export interface LibraryItem {
  _id: string
  name: string
  type: string
  poster?: string
  removed: boolean
  temp?: boolean
  _ctime?: string
  _mtime?: string
  state?: Record<string, unknown>
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

  /**
   * Login with email and password
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    try {
      const response = await this.client.post('/api/login', {
        type: 'Auth',
        email,
        password,
      })

      if (response.data?.error) {
        // Carry forward the specific error message from Stremio (e.g., USER_NOT_FOUND)
        const errData = response.data.error
        const err = new Error(errData.message || 'Login failed')
          ; (err as any).code = errData.code || errData.message // Sometimes code is in message field in older APIs
        throw err
      }

      if (!response.data?.result?.authKey) {
        throw new Error('Invalid login response - no auth key')
      }

      return response.data.result
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Invalid email or password')
        }
        if (error.code === 'ERR_NETWORK') {
          throw new Error('Network error - check your internet connection or CORS configuration')
        }
        throw new Error(error.response?.data?.error || error.message || 'Login failed')
      }
      throw error
    }
  }

  /**
   * Register a new Stremio account
   */
  async register(email: string, password: string): Promise<LoginResponse> {
    try {
      const response = await this.client.post('/api/register', {
        type: 'Auth',
        email,
        password,
      })

      if (response.data?.error) {
        throw new Error(response.data.error.message || 'Registration failed')
      }

      if (!response.data?.result?.authKey) {
        throw new Error('Invalid registration response - no auth key')
      }

      return response.data.result
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(error.response?.data?.error || error.message || 'Registration failed')
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

    let lastError: unknown
    for (let i = 0; i <= retries; i++) {
      try {
        if (i > 0) {
          console.log(`[Manifest Fetch] Retrying (${i}/${retries}) for: ${manifestUrl}`)
          // Small delay before retry
          await new Promise((resolve) => setTimeout(resolve, 1000 * i))
        } else {
          console.log(
            `[Manifest Fetch] Fetching ${shouldFetchDirectly ? 'directly' : 'via proxy'}: ${manifestUrl}`
          )
        }

        const response = await axios.get(fetchUrl, {
          timeout: 15000,
          headers: shouldFetchDirectly ? {} : { 'x-account-context': accountContext }
        })

        // allorigins might return the data as a string, so parse it if needed
        let manifestData = response.data
        if (typeof manifestData === 'string') {
          try {
            manifestData = JSON.parse(manifestData)
          } catch {
            console.error(
              `[Manifest Fetch] Failed to parse JSON for ${manifestUrl}:`,
              response.data
            )
            throw new Error('Invalid addon manifest - could not parse JSON')
          }
        }

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
        lastError = error
        console.warn(
          `[Manifest Fetch] Attempt ${i + 1} failed for ${manifestUrl}:`,
          error instanceof Error ? error.message : error
        )

        // If it's a 404, don't retry
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          throw new Error('Addon manifest not found at this URL')
        }
      }
    }

    // If we're here, all retries failed
    if (axios.isAxiosError(lastError)) {
      throw new Error(lastError.message || 'Failed to fetch addon manifest after retries')
    }
    throw lastError
  }



  /**
   * Get user's library items (Watch History)
   * Uses datastoreGet with collection: 'libraryItem' to match Syncio's implementation
   */
  async getLibraryItems(authKey: string): Promise<LibraryItem[]> {
    try {
      const response = await this.client.post('/api/datastoreGet', {
        type: 'DatastoreGet',
        authKey,
        collection: 'libraryItem',
        ids: [],
        all: true,
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
  }): Promise<void> {
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

      await this.client.post('/api/datastorePut', {
        type: 'Put',
        authKey,
        collection: 'libraryItem',
        changes: [libraryItem]
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
  async removeLibraryItem(authKey: string, itemId: string): Promise<void> {
    try {
      const libraryItem = {
        _id: itemId,
        removed: true,
        _mtime: new Date().toISOString(),
      }

      await this.client.post('/api/datastorePut', {
        type: 'Put',
        authKey,
        collection: 'libraryItem',
        changes: [libraryItem]
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
