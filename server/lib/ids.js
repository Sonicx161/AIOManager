// Ids being created now: the app has always generated UUIDs for workspaces and devices, so ':' and control characters are refused.
const MAX_NEW_ID_LENGTH = 128

const hasControlCharacter = (value) => {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i)
        if (code < 32 || code === 127) return true
    }
    return false
}

export const isAcceptableNewId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_NEW_ID_LENGTH && !hasControlCharacter(value) && !value.includes(':')
