import { readApiErrorMessage } from '@/api/error-message'
import { resilientFetch } from '@/lib/api-resilience'
import { useSyncStore, getSyncApiPath } from '@/store/syncStore'
import { getDeviceAwareAuthHeaders } from '@/lib/device-session'

async function getAuthHeaders(): Promise<Record<string, string>> {
    return getDeviceAwareAuthHeaders()
}

export async function downloadNuvioBackup(accountId: string, connectionId: string): Promise<void> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/nuvio/backup-export`, {
        method: 'POST',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ accountId, connectionId }),
        timeout: 30000,
    })
    if (!res.ok) {
        throw new Error(await readApiErrorMessage(res))
    }

    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const now = new Date()
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const a = document.createElement('a')
    a.href = url
    a.download = `nuvio-backup-${date}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
}
