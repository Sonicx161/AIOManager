import net from 'net'
import { forwardedInfo, isPrivateOrLoopback, isCloudflare } from '../admin/net.js'

// Plain-language proxy warning, logged once per start. Two shapes reveal an unrecognised
// public proxy: forwarded headers from a public peer that is not trusted (it is treated as
// the client), and a trusted local proxy whose chain walk stops at an unrecognised public
// address that still has entries to its left, meaning it appends for its own visitors.
// Until such a proxy is pinned its visitors share one rate limit and one sign-in lockout;
// every recognised setup is zero-setup and never sees this warning.
let unpinnedPeer = null

export function resetProxyTrustWarnings() {
    unpinnedPeer = null
}

// Fires once, on the first request that reveals an unrecognised public proxy: either it
// connects directly (its forwarded headers are ignored, so it is both peer and client) or
// it forwards through a trusted proxy (the walk stops at it, with entries to its left).
// Private, Docker network and Cloudflare addresses never warn: the first are visitors or
// auto-trusted proxies, the last is trusted built in.
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
    if (!peer || !net.isIP(peer) || isPrivateOrLoopback(peer) || isCloudflare(peer)) return
    unpinnedPeer = peer
    log.warn({ category: 'Security' },
        `Visitors are reaching AIOManager through a proxy at ${peer} that I don't recognise, so they all share one rate limit and one sign-in lockout. If that's your proxy, add TRUSTED_PROXY_CIDRS=${peer} to your settings.`)
}
