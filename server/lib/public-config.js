import { isRegistrationsClosed } from '../config.js'

// Served to anyone by GET /api/config. Every setting read here must be listed in
// PUBLIC_SETTING_KEYS (admin/settings-registry.js) and can never be a secret.
export function publicConfig() {
    return {
        customHtml: process.env.CUSTOM_HTML || null,
        registrationsClosed: isRegistrationsClosed(),
    }
}
