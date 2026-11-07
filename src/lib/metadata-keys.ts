import { useSyncStore } from '@/store/syncStore'
import { getSyncPasswordHeader } from '@/lib/sync-auth'
import { typedClient } from '@/api/typed-client'

export type MetadataKeyFormat = 'v3' | 'v4' | 'unknown'

export interface ConfiguredProvider {
    provider: string
    keyFormat: MetadataKeyFormat
    updatedAt?: string
}

export interface SavedKeyInfo {
    provider: string
    keyFormat: MetadataKeyFormat
}

async function authHeaders(): Promise<Record<string, string>> {
    const auth = useSyncStore.getState().auth
    const headers: Record<string, string> = {}
    if (auth.isAuthenticated) {
        headers['x-sync-user'] = auth.id
        headers['x-sync-password'] = await getSyncPasswordHeader(auth)
    }
    return headers
}

export function detectKeyFormat(value: string): MetadataKeyFormat {
    const trimmed = value.trim()
    if (!trimmed) return 'unknown'
    if (/^[0-9a-fA-F]{32}$/.test(trimmed)) return 'v3'
    if (trimmed.startsWith('eyJ')) return 'v4'
    return 'unknown'
}

export function maskKeyValue(): string {
    return `${'\u00B7'.repeat(8)}${'*'.repeat(20)}${'\u00B7'.repeat(4)}`
}

export async function listMetadataKeys(): Promise<ConfiguredProvider[]> {
    const { data: json, error, response } = await typedClient.GET('/api/metadata-keys')
    if (error || !response.ok) {
        throw new Error(error?.error || 'Failed to load keys')
    }
    return json.providers.map((p) => ({
        provider: String(p.provider ?? ''),
        keyFormat: (p.keyFormat === 'v3' || p.keyFormat === 'v4' ? p.keyFormat : 'unknown') as MetadataKeyFormat,
        updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : undefined,
    }))
}

export async function saveMetadataKey(provider: string, key: string): Promise<SavedKeyInfo> {
    const res = await fetch('/api/metadata-keys', {
        method: 'POST',
        headers: { ...await authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key }),
    })
    const json = await res.json()
    if (!res.ok || !json.success) {
        throw new Error(json?.error?.message || json?.error || 'Failed to save key')
    }
    return {
        provider: String(json.provider ?? provider),
        keyFormat: (json.keyFormat === 'v3' || json.keyFormat === 'v4' ? json.keyFormat : 'unknown') as MetadataKeyFormat,
    }
}

export async function deleteMetadataKey(provider: string): Promise<void> {
    const res = await fetch(`/api/metadata-keys/${encodeURIComponent(provider)}`, {
        method: 'DELETE',
        headers: await authHeaders(),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || (json && json.success === false)) {
        throw new Error(json?.error?.message || json?.error || 'Failed to delete key')
    }
}

export async function getMetadataKeyValue(provider: string): Promise<string> {
    const res = await fetch(`/api/metadata-keys/${encodeURIComponent(provider)}/value`, {
        headers: await authHeaders(),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
        throw new Error(json?.error?.message || json?.error || 'Failed to get key')
    }
    return json.key || ''
}

export interface AIOMetadataImportResult {
    imported: SavedKeyInfo[]
}

export async function importFromAIOMetadata(payload: {
    aiometadataUrl: string
    uuid: string
    password: string
    addonPassword?: string
}): Promise<AIOMetadataImportResult> {
    const res = await fetch('/api/metadata-keys/import-aiometadata', {
        method: 'POST',
        headers: { ...await authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })
    const json = await res.json()
    if (!res.ok || json.error) {
        throw new Error(json?.error?.message || json?.error || 'Import failed')
    }
    const imported = Array.isArray(json.imported) ? json.imported : []
    return {
        imported: imported.map((p: Partial<SavedKeyInfo> & { keyFormat?: string }) => ({
            provider: String(p.provider ?? ''),
            keyFormat: (p.keyFormat === 'v3' || p.keyFormat === 'v4' ? p.keyFormat : 'unknown') as MetadataKeyFormat,
        })),
    }
}

export interface TestKeyResult {
    success: boolean
    message: string
    source: string | null
}

export async function testMetadataKey(provider?: string, key?: string): Promise<TestKeyResult> {
    const params = new URLSearchParams()
    if (provider) params.set('provider', provider)
    if (key) params.set('key', key)
    const url = `/api/metadata/test${params.toString() ? '?' + params : ''}`
    const res = await fetch(url, { headers: await authHeaders() })
    const json = await res.json().catch(() => null)
    if (!res.ok && !json) {
        throw new Error('Test request failed')
    }
    return {
        success: Boolean(json?.success),
        message: String(json?.message ?? 'Unknown result'),
        source: json?.source ?? null,
    }
}
