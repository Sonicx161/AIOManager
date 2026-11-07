import type { Connection, MediaServerIdentity } from '../../types/connection.ts'
import type { JellyfinSecret } from './connection-data.ts'
import { createJellyfinClient, JellyfinError, normalizeJellyfinUrl } from './client.ts'

export { normalizeJellyfinUrl } from './client.ts'

export interface JellyfinLogin {
    baseUrl: string
    method: 'password' | 'token'
    username?: string
    password?: string
    accessToken?: string
    userId?: string
}

export interface JellyfinSession {
    secret: JellyfinSecret
    identity: MediaServerIdentity
}

export function jellyfinSignInErrorMessage(error: unknown, login: Pick<JellyfinLogin, 'method' | 'userId'>): string {
    if (!(error instanceof JellyfinError)) return error instanceof Error ? error.message : 'Could not verify the media-server sign-in'
    if (error.kind === 'network' || error.kind === 'timeout') {
        return 'Could not reach the media server. Check the full server address, HTTPS and browser access (CORS), then retry.'
    }
    if (error.kind === 'auth') {
        if (login.method === 'token' && !login.userId?.trim() && (error.status === 400 || error.status === 404)) {
            return 'Enter the Remote user ID for this API key, then verify sign-in again.'
        }
        if (error.status === 403) return 'The server denied access. Check the remote user permissions and sign-in credentials.'
        return login.method === 'password'
            ? 'Sign-in was rejected. Check the server username, password and any required user PIN.'
            : 'Sign-in was rejected. Check the token or API key and the Remote user ID, then reconnect.'
    }
    if (error.kind === 'server') return `The media server could not complete sign-in${error.status ? ` (HTTP ${error.status})` : ''}. Try again later.`
    if (error.kind === 'unsupported' || error.kind === 'invalid-response') {
        return 'The server could not verify this sign-in. Check the full address and that it supports the Jellyfin API.'
    }
    return error.message
}

// The setup flow and media reads share one transport and one verified remote user.
export class JellyfinClient {
    readonly baseUrl: string
    private readonly deviceId: string
    private readonly client: ReturnType<typeof createJellyfinClient>

    constructor(baseUrl: string, deviceId: string, fetcher?: typeof fetch) {
        this.baseUrl = normalizeJellyfinUrl(baseUrl)
        this.deviceId = deviceId
        this.client = createJellyfinClient(this.baseUrl, { deviceId, fetch: fetcher })
    }

    /** Public, read-only discovery used to prefill the Add Connection picker. */
    async listPublicUsers(signal?: AbortSignal) {
        return this.client.listPublicUsers(signal)
    }

    async signIn(login: JellyfinLogin, signal?: AbortSignal): Promise<JellyfinSession> {
        let signedIn
        if (login.method === 'password') {
            if (!login.username?.trim()) throw new Error('Enter your server username')
            signedIn = await this.client.signIn(login.username.trim(), login.password || '', signal)
            signedIn.user = await this.client.getUser(signedIn.accessToken, signedIn.user.Id, signal)
        } else {
            const token = login.accessToken?.trim()
            if (!token) throw new Error('Enter a session token or API key')
            signedIn = await this.client.connectToken(token, login.userId?.trim() || undefined, signal)
        }

        let details: Awaited<ReturnType<typeof this.client.inspect>> | undefined
        try {
            details = await this.client.inspect(signedIn.accessToken, signedIn.user, signal)
        } catch (error) {
            // Product information is optional after verifying the user. A failed
            // authentication or cancellation still invalidates the check.
            if (signal?.aborted || (error instanceof JellyfinError && (error.status === 401 || error.kind === 'aborted'))) throw error
        }
        const product = details?.product || 'compatible'
        const productName = product === 'aiometadata' ? 'AIOMetadata' : product === 'aiostreams' ? 'AIOStreams'
            : product === 'jellyfin' ? 'Jellyfin' : 'Jellyfin-compatible server'
        const userName = typeof signedIn.user.Name === 'string' && signedIn.user.Name.trim()
            ? signedIn.user.Name : signedIn.user.Id
        return {
            secret: { baseUrl: this.baseUrl, accessToken: signedIn.accessToken, deviceId: this.deviceId, userId: signedIn.user.Id },
            identity: {
                product, productName, packageName: details?.packageName,
                serverId: details?.serverId || signedIn.serverId, serverName: details?.serverName,
                version: details?.version, userId: signedIn.user.Id, userName,
                authMethod: login.method, lastCheckedAt: Date.now(),
            },
        }
    }
}

export function validateJellyfinReconnect(connection: Connection, session: JellyfinSession, previous?: JellyfinSecret): void {
    const current = connection.mediaServer
    const wrongUrl = previous && normalizeJellyfinUrl(previous.baseUrl) !== session.secret.baseUrl
    const wrongUser = !current?.userId || current.userId !== session.secret.userId
    const wrongServer = current?.serverId && session.identity.serverId && current.serverId !== session.identity.serverId
    const unverifiedServer = !previous && (!current?.serverId || current.serverId !== session.identity.serverId)
    if (wrongUrl || wrongUser || wrongServer || unverifiedServer) {
        throw new Error('Reconnect to the same server and remote user. Use Add Connection for a different server or user.')
    }
}
