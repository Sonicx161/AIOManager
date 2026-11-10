import net from 'net'
import { forwardedInfo, isPrivateOrLoopback, isCloudflare } from '../admin/net.js'
import { trustPrivateNetworks } from '../admin/config.js'

// Plain-language proxy warning, logged once per start. Two shapes reveal an unrecognised
// public proxy: forwarded headers from a public peer that is not trusted (it is treated as
// the client), and a trusted local proxy whose chain walk stops at an unrecognised public
// address that still has entries to its left, meaning it appends for its own visitors.
// Until such a proxy is pinned its visitors share one rate limit;
// every recognised setup is zero-setup and never sees this warning.
let unpinnedPeer = null

export function resetProxyTrustWarnings() {
    unpinnedPeer = null
}

// Fires once, on the first request that reveals an unrecognised public proxy: either it
// connects directly (its forwarded headers are ignored, so it is both peer and client) or
// it forwards through a trusted proxy (the walk stops at it, with entries to its left).
// Cloudflare never warns. Private and Docker network addresses warn only when
// TRUST_PRIVATE_NETWORKS=false, since otherwise they are trusted automatically.
export function warnUnpinnedPublicProxy(request, log) {
    if (unpinnedPeer) return
    const info = forwardedInfo(request)
    if (!info.present) return
    let peer = null
    if (!info.trusted) {
        peer = info.peer
    } else if (info.untrustedStop && info.forwardedLeft) {
        peer = info.untrustedStop
    }
    if (!peer || !net.isIP(peer) || isCloudflare(peer)) return
    if (isPrivateOrLoopback(peer) && trustPrivateNetworks()) return
    unpinnedPeer = peer
    const effect = info.trusted
        ? 'so everyone coming through it shares one rate limit'
        : 'so everyone coming through it shares one rate limit and cannot sign in to the Dashboard'
    log.warn({ category: 'Security' },
        `Visitors are reaching AIOManager through a proxy at ${peer} that isn't trusted, ${effect}. If that's your proxy, add TRUSTED_PROXY_CIDRS=${peer} to your .env file or Docker environment and restart.`)
}
