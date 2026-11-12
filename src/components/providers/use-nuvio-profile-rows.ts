import { useEffect, useState } from 'react'
import type { Connection } from '@/types/connection'
import { cachedRead, peekDisplayCache } from '@/lib/display-read-cache'
import { readNuvioProfiles } from '@/lib/nuvio-data'
import { nuvioReadIdentity } from './NuvioWorkspace'

export interface NuvioProfileRowSummary {
    id: string
    profile_index: number
    name?: string
}

const canFetchProfiles = (connection: Connection) =>
    connection.enabled !== false
    && connection.capabilities?.includes('profiles') === true

// Reads the same cached profile list as the Nuvio profile picker, so labels never add a fetch.
export function useNuvioProfileRows(accountId: string | undefined, connections: readonly Connection[]): Record<string, NuvioProfileRowSummary[]> {
    const [rowsByConnection, setRowsByConnection] = useState<Record<string, NuvioProfileRowSummary[]>>({})
    useEffect(() => {
        if (!accountId) return
        let cancelled = false
        const targets = connections.filter(connection => connection.platform === 'nuvio'
            && (connection.credentials?.profileIndex || connection.credentials?.profileId))
        const painted: Record<string, NuvioProfileRowSummary[]> = {}
        for (const connection of targets) {
            const cached = peekDisplayCache<NuvioProfileRowSummary[]>(`nuvio:profiles:${nuvioReadIdentity(accountId, connection, false)}`)
            if (cached?.value?.length) painted[connection.id] = cached.value
        }
        if (Object.keys(painted).length) setRowsByConnection(previous => ({ ...previous, ...painted }))
        for (const connection of targets) {
            if (painted[connection.id] || !canFetchProfiles(connection)) continue
            cachedRead(`nuvio:profiles:${nuvioReadIdentity(accountId, connection, false)}`, () => readNuvioProfiles(accountId, connection))
                .then(rows => { if (!cancelled && rows.length) setRowsByConnection(previous => ({ ...previous, [connection.id]: rows })) })
                .catch(() => {})
        }
        return () => { cancelled = true }
    }, [accountId, connections])
    return rowsByConnection
}
