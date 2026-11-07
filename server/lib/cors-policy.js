import { isAdminPath } from '../admin/paths.js'

// The Dashboard API never takes cross-origin requests, preflight included, however the
// path is encoded; every other route keeps the configured CORS origins.
export const corsDelegator = (origins) => (request, callback) => callback(null, { origin: isAdminPath(request.url) ? false : origins })
