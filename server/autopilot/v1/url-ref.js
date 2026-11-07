import { createHash } from 'node:crypto'
import { normalizeAddonUrl } from '../../utils/addon-url.js'

// Stable stand-in for an addon, check or webhook URL in logs and traces.
export const urlRef = (url, prefix = 'ad') => `${prefix}_${createHash('sha256').update(normalizeAddonUrl(url)).digest('hex').slice(0, 16)}`

// Error text can quote a URL (a transport message, a JSON parse snippet); logs keep the text minus URLs.
export const scrubUrls = (text) => String(text ?? '').replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '<url>')
