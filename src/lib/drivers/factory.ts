import { createNuvioDriver } from './nuvio'
import type { Connection } from '@/types/connection'

type ConnLike = Pick<Connection, 'credentials'>

// Single place that maps a connection's stored credentials to each driver's options, so the
// creds-to-options shape isn't duplicated at every call site (push, library cache, surfaces).
export function nuvioDriverFor(conn: ConnLike) {
    const c = conn.credentials || {}
    return createNuvioDriver({ baseUrl: c.baseUrl, publishableKey: c.publishableKey })
}
