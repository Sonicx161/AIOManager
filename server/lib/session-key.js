// A session key is a device credential the server issues for one signed-in tab. Its device id carries this prefix,
// so it needs no schema change. An older server cannot read its hash format and refuses it; the tab then uses its password token.
export const SESSION_DEVICE_PREFIX = 'session:'
export const SESSION_DEVICE_LIKE = `${SESSION_DEVICE_PREFIX}%`
export const SESSION_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000
export const SESSION_KEYS_PER_ACCOUNT = 20

export const isSessionDevice = (deviceId) => typeof deviceId === 'string' && deviceId.startsWith(SESSION_DEVICE_PREFIX)
