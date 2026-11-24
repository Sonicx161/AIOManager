import { maskSecretUrl } from '../../../lib/mask-secret-url.ts'
import { maskUrlLevel } from '../../../lib/utils.ts'

function splitPath(pathname: string): string[] {
    const segments = pathname.split('/').filter(Boolean)
    if (segments[segments.length - 1] === 'manifest.json') segments.pop()
    return segments
}

// Display-only: host plus the first changed path segment, masked; the rest collapses to "...".
export function formatReplacePreviewUrl(oldUrl: string, newUrl: string, urlPrivacyLevel = 0): string {
    if (urlPrivacyLevel > 0) return maskUrlLevel(newUrl, urlPrivacyLevel)
    let before: URL
    let after: URL
    try {
        before = new URL(maskSecretUrl(oldUrl))
        after = new URL(maskSecretUrl(newUrl))
    } catch {
        return maskSecretUrl(newUrl)
    }
    const scheme = after.protocol === 'https:' ? '' : `${after.protocol}//`
    const oldSegments = splitPath(before.pathname)
    const newSegments = splitPath(after.pathname)
    const changed = newSegments.findIndex((segment, i) => segment !== oldSegments[i])
    const queryTail = after.search || after.hash ? '/...' : ''
    if (changed < 0) {
        return `${scheme}${after.host}${newSegments.length > 0 ? '/...' : queryTail}`
    }
    const lead = changed > 0 ? '/...' : ''
    const tail = changed < newSegments.length - 1 ? '/...' : queryTail
    return `${scheme}${after.host}${lead}/${newSegments[changed]}${tail}`
}
