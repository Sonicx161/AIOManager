import { accountHandle } from '../utils/acct-handle.js'

// Structured log fields carry the account handle, never the raw account id.
const HANDLE_RE = /^acct-[0-9a-f]{12}$/

export const logFormatters = {
    log(obj) {
        return typeof obj.acct === 'string' && obj.acct && !HANDLE_RE.test(obj.acct) ? { ...obj, acct: accountHandle(obj.acct) } : obj
    },
}
