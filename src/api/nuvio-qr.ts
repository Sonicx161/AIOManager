import { readApiErrorMessage } from '@/api/error-message'
import type { QRSession, QRPollOutcome } from '@/lib/qr-device-link'
import { mapNuvioPollErrorStatus, mapNuvioPollStatus, parseExpiry } from '@/lib/qr-device-link'
import { useSyncStore, getSyncApiPath } from '@/store/syncStore'
import { getDeviceAwareAuthHeaders } from '@/lib/device-session'

interface NuvioQrStartResponse {
    code: string
    qrContent?: string
    qrImageUrl: string
    webUrl: string
    expiresAt: string | number
    pollIntervalSeconds?: number
    anonToken?: string
}

export interface NuvioQrExchangeResult {
    tokens: { accessToken: string; refreshToken: string; expiresAt: number }
    profiles: Array<{ id: string; name: string }>
    email?: string
}

function platformDataOf(session: QRSession): { deviceNonce?: string; anonToken?: string } {
    if (session.platformData && typeof session.platformData === 'object') {
        return session.platformData as { deviceNonce?: string; anonToken?: string }
    }
    return {}
}

async function postQr<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    const { serverUrl } = useSyncStore.getState()
    const headers = await getDeviceAwareAuthHeaders()
    const res = await fetch(`${getSyncApiPath(serverUrl)}/providers/nuvio/qr/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    })
    if (!res.ok) {
        const err = new Error(await readApiErrorMessage(res)) as Error & { status: number }
        err.status = res.status
        throw err
    }
    return res.json()
}

export async function startNuvioQr(publishableKey?: string, baseUrl?: string): Promise<QRSession> {
    const deviceNonce = crypto.randomUUID()
    const data = await postQr<NuvioQrStartResponse>('start', {
        deviceNonce,
        deviceName: 'AIOManager',
        publishableKey,
        baseUrl,
    })
    // Official Nuvio clients fall back to a public QR renderer when the session omits the image.
    const qrImage = data.qrImageUrl
        || `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(data.qrContent || data.webUrl)}`
    return {
        qrImage,
        link: data.webUrl,
        code: data.code,
        expiresAt: parseExpiry(data.expiresAt),
        pollIntervalMs: data.pollIntervalSeconds != null ? data.pollIntervalSeconds * 1000 : undefined,
        platformData: { deviceNonce, anonToken: data.anonToken },
    }
}

export async function pollNuvioQr(session: QRSession, publishableKey?: string, baseUrl?: string): Promise<QRPollOutcome> {
    const { deviceNonce, anonToken } = platformDataOf(session)
    try {
        const data = await postQr<{ status?: string }>('poll', {
            code: session.code,
            deviceNonce,
            anonToken,
            publishableKey,
            baseUrl,
        })
        return mapNuvioPollStatus(data.status)
    } catch (err) {
        return mapNuvioPollErrorStatus((err as { status?: number }).status)
    }
}

export async function exchangeNuvioQr(session: QRSession, publishableKey?: string, baseUrl?: string): Promise<NuvioQrExchangeResult> {
    const { deviceNonce } = platformDataOf(session)
    return postQr<NuvioQrExchangeResult>('exchange', {
        code: session.code,
        deviceNonce,
        publishableKey,
        baseUrl,
    })
}
