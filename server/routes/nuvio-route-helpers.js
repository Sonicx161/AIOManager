export async function nuvioDriverFrom(body = {}) {
    const { createNuvioDriver } = await import('../providers/nuvio-driver.js')
    return createNuvioDriver({
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.publishableKey ? { publishableKey: body.publishableKey } : {})
    })
}

// sessionAware surfaces an upstream 400 (P0001 session raise) as a client 400; only the
// qr/poll and qr/exchange routes want that — the password-auth ladder must let a 400
// fall through to the isAuthError ? 401 : 502 branch.
const MAX_STATED_WAIT_SEC = 48 * 60 * 60

function statedWait(retryAfterSec) {
    if (!Number.isSafeInteger(retryAfterSec) || retryAfterSec <= 0 || retryAfterSec > MAX_STATED_WAIT_SEC) return 'a few minutes'
    const minutes = Math.ceil(retryAfterSec / 60)
    if (minutes > 90) return `about ${Math.ceil(minutes / 60)} hours`
    return `about ${minutes} minute${minutes === 1 ? '' : 's'}`
}

export function nuvioSignInLimitMessage(retryAfterSec) {
    const wait = statedWait(retryAfterSec)
    return `Nuvio is limiting sign-ins from this server. Try again in ${wait}, or use Sign in with QR code.`
}

export function mapNuvioLoginError(reply, err, { authMessage, sessionAware = false, timeoutMessage, passwordSignIn = false } = {}) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        reply.code(504)
        return { error: timeoutMessage || 'Nuvio login timed out. Please try again in a few seconds.' }
    }
    if (sessionAware && err.status === 400) {
        reply.code(400)
        return { error: 'Invalid or expired login session' }
    }
    if (err.status === 429) {
        reply.code(429)
        if (passwordSignIn) return { error: nuvioSignInLimitMessage(err.retryAfterSec) }
        return { error: 'Too many login attempts. Please wait a few minutes before retrying.' }
    }
    const status = err.isAuthError ? 401 : 502
    reply.code(status)
    return { error: err.isAuthError ? authMessage : 'Nuvio service unreachable' }
}
