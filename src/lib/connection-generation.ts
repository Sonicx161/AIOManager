// Deterministic incarnation token for legacy connections (SOL-R3-03): two devices
// holding the same pre-generation connection must mint the SAME token, or each
// invents a competing incarnation and a removal from one leaves the other's server
// rows behind. The token is a versioned digest of the stable account and connection
// ids only, so independent migrations converge. Freshly added connections and
// explicit restores keep random tokens (src/store/connectionStore.ts). The server
// treats a generation as an opaque equality token matching [A-Za-z0-9_-]{1,64}, so
// the digest avoids other separators and stays within that bound.
const LEGACY_GENERATION_VERSION = 'legacy-v1'
const LEGACY_GENERATION_HASH_CHARS = 32

export async function legacyConnectionGeneration(accountId: string, connectionId: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${accountId}:${connectionId}`))
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    return `${LEGACY_GENERATION_VERSION}-${hex.slice(0, LEGACY_GENERATION_HASH_CHARS)}`
}
